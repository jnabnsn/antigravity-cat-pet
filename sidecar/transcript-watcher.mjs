import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const EXIT_CODE_RE = /Command exited with code\s+(-?\d+)/;

function extractUserPrompt(content) {
  const str = String(content || '');
  const m = USER_REQ_RE.exec(str);
  const raw = m ? m[1] : str;
  return raw.replace(/\s+/g, ' ').trim().slice(0, 42);
}

function extractToolDetail(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const name = String(toolCall.name || '');
  const args = toolCall.args;
  if (!args || typeof args !== 'object') return '';

  if (
    name === 'read_file' ||
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'view_file' ||
    name === 'replace_file_content' ||
    name === 'multi_replace_file_content'
  ) {
    const p = String(args.Path || args.path || args.TargetFile || '');
    return p ? path.basename(p).slice(0, 40) : '';
  }
  if (name === 'run_command') {
    const summary = String(args.toolSummary || '').trim();
    if (summary) return summary.slice(0, 32);
    const cmd = String(args.CommandLine || '').replace(/\s+/g, ' ').trim();
    return cmd.slice(0, 28);
  }
  if (name === 'invoke_subagent') {
    return String(args.Role || args.TypeName || '').slice(0, 28);
  }
  if (name === 'search_web' || name === 'grep_search' || name === 'find_by_name') {
    return String(args.query || args.Query || args.Pattern || '').slice(0, 28);
  }
  return '';
}

function extractTokens(obj) {
  let total = 0;
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens']) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      total += Math.floor(v);
    }
  }
  return total;
}

export class TranscriptWatcher extends EventEmitter {
  /**
   * Tails Antigravity brain transcripts in real time without external dependencies.
   */
  constructor({ pollIntervalMs = 300, brainRoots = null } = {}) {
    super();
    this.pollIntervalMs = pollIntervalMs;
    const home = os.homedir();
    const roots = brainRoots || [
      process.env.ANTIGRAVITY_APP_DATA_DIR
        ? path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain')
        : null,
      path.join(home, '.gemini', 'antigravity', 'brain'),
      path.join(home, '.gemini', 'antigravity-ide', 'brain'),
      path.join(home, '.gemini', 'antigravity-cli', 'brain')
    ].filter(Boolean);

    this._brainRoots = [...new Set(roots.map((r) => path.resolve(r)))];
    this._offsets = new Map();
    this._buffers = new Map();
    this._primaryConvs = new Set();
    this._trackedFiles = new Set();
    this._lastDiscoveryAt = 0;
    this._timer = null;
    this._stopped = false;
  }

  get trackedCount() {
    return this._trackedFiles.size;
  }

  start() {
    this._stopped = false;
    this._seedInitialOffsets();
    this._lastDiscoveryAt = Date.now();
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _discoverTranscripts() {
    const found = new Set();
    for (const root of this._brainRoots) {
      if (!fs.existsSync(root)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const tfile = path.join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (fs.existsSync(tfile)) {
            found.add(tfile);
          }
        } catch {
          // ignore
        }
      }
    }
    return found;
  }

  _isPrimaryConversation(filePath) {
    if (this._primaryConvs.has(filePath)) return true;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(16384);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.toString('utf8', 0, bytesRead);
        if (head.includes('"USER_EXPLICIT"')) {
          this._primaryConvs.add(filePath);
          return true;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // ignore
    }
    return false;
  }

  _seedInitialOffsets() {
    const files = this._discoverTranscripts();
    this._trackedFiles = files;
    const now = Date.now();
    let freshestFile = null;
    let freshestMtime = 0;

    for (const filePath of files) {
      try {
        const st = fs.statSync(filePath);
        this._offsets.set(filePath, st.size);
        this._buffers.set(filePath, '');
        if (this._isPrimaryConversation(filePath) && st.mtimeMs > freshestMtime) {
          freshestMtime = st.mtimeMs;
          freshestFile = filePath;
        }
      } catch {
        // ignore
      }
    }

    this.emit('status', {
      trackedCount: files.size,
      message: `实时会话监控已连接（监听 ${files.size} 个 Antigravity 会话）`
    });

    if (freshestFile && now - freshestMtime < 25000) {
      this._emitTailSnapshot(freshestFile);
    }
  }

  _emitTailSnapshot(filePath) {
    try {
      const st = fs.statSync(filePath);
      const start = Math.max(0, st.size - 16384);
      const len = st.size - start;
      if (len <= 0) return;

      const fd = fs.openSync(filePath, 'r');
      let tail = '';
      try {
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, start);
        tail = buf.toString('utf8', 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }

      const lines = tail.split(/\r?\n/).filter((ln) => ln.trim());
      for (const line of lines.slice(-5).reverse()) {
        let obj = null;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj && (obj.type === 'USER_INPUT' || obj.type === 'PLANNER_RESPONSE' || obj.type === 'GENERIC')) {
          if (obj.type === 'PLANNER_RESPONSE' && (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)) {
            return;
          }
          this._processStep(filePath, obj, true);
          return;
        }
      }
    } catch {
      // ignore
    }
  }

  _tick() {
    if (this._stopped) return;
    const now = Date.now();
    if (now - this._lastDiscoveryAt >= 1500) {
      this._lastDiscoveryAt = now;
      const current = this._discoverTranscripts();
      let changed = false;
      for (const p of current) {
        if (!this._trackedFiles.has(p)) {
          this._offsets.set(p, 0);
          this._buffers.set(p, '');
          changed = true;
        }
      }
      if (changed || current.size !== this._trackedFiles.size) {
        this._trackedFiles = current;
        this.emit('status', {
          trackedCount: current.size,
          message: `实时会话监控已更新（监听 ${current.size} 个 Antigravity 会话）`
        });
      }
    }

    for (const filePath of this._trackedFiles) {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      let prev = this._offsets.get(filePath) || 0;
      if (size < prev) {
        prev = 0;
        this._buffers.set(filePath, '');
      }
      if (size > prev) {
        this._readNewLines(filePath, prev, size);
      }
    }
  }

  _readNewLines(filePath, start, end) {
    const length = end - start;
    if (length <= 0) return;

    let chunkText = '';
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, start);
        this._offsets.set(filePath, start + bytesRead);
        chunkText = buf.toString('utf8', 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const combined = (this._buffers.get(filePath) || '') + chunkText;
    const lines = combined.split('\n');
    this._buffers.set(filePath, lines.pop() || '');

    let isPrimary = this._isPrimaryConversation(filePath);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let obj = null;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.source === 'USER_EXPLICIT') {
        this._primaryConvs.add(filePath);
        isPrimary = true;
      }
      this._processStep(filePath, obj, isPrimary);
    }
  }

  _processStep(filePath, obj, isPrimary) {
    const stepType = String(obj.type || '');
    const source = String(obj.source || '');
    const status = String(obj.status || '');
    const convDir = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
    const convId = convDir.slice(0, 8);
    const tokens = extractTokens(obj);
    const model = String(obj.model || '');

    if (!isPrimary) {
      if (stepType === 'PLANNER_RESPONSE' && Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        const tc = obj.tool_calls[obj.tool_calls.length - 1] || {};
        this.emit('activity', {
          origin: 'subagent',
          event: 'ToolStart',
          tool: String(tc.name || 'subagent'),
          detail: extractToolDetail(tc),
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });
      }
      return;
    }

    if (stepType === 'USER_INPUT' && source === 'USER_EXPLICIT') {
      const prompt = extractUserPrompt(obj.content);
      this.emit('activity', {
        origin: 'transcript',
        event: 'Thinking',
        prompt,
        detail: '收到新指令，哈Gemi 正在思考冒泡…',
        tokens: 0,
        model,
        conv: convId,
        ts: Date.now()
      });
      return;
    }

    if (stepType === 'PLANNER_RESPONSE') {
      const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      const content = String(obj.content || '').trim();

      if (status === 'ERROR') {
        this.emit('activity', {
          origin: 'transcript',
          event: 'Error',
          error: '喵呜！模型响应遇到错误啦！',
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });
      } else if (toolCalls.length > 0) {
        const lastTc = toolCalls[toolCalls.length - 1] || {};
        this.emit('activity', {
          origin: 'transcript',
          event: 'ToolStart',
          tool: String(lastTc.name || 'tool'),
          detail: extractToolDetail(lastTc),
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });
      } else if (content && status === 'DONE') {
        this.emit('activity', {
          origin: 'transcript',
          event: 'TurnComplete',
          detail: content.slice(0, 32).replace(/\s+/g, ' '),
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });
      } else {
        this.emit('activity', {
          origin: 'transcript',
          event: 'Thinking',
          detail: '哈Gemi 深度思考碎碎念中…',
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });
      }
      return;
    }

    if (stepType === 'GENERIC') {
      const content = String(obj.content || '');
      let hasError = status === 'ERROR';
      if (!hasError) {
        const m = EXIT_CODE_RE.exec(content);
        if (m && m[1] !== '0') {
          hasError = true;
        }
      }
      if (hasError) {
        this.emit('activity', {
          origin: 'transcript',
          event: 'ToolError',
          error: '吓了一跳！刚才的工具执行出错啦~',
          tokens: 0,
          model,
          conv: convId,
          ts: Date.now()
        });
      } else {
        this.emit('activity', {
          origin: 'transcript',
          event: 'Thinking',
          detail: '正在分析执行结果喵…',
          tokens: 0,
          model,
          conv: convId,
          ts: Date.now()
        });
      }
    }
  }
}
