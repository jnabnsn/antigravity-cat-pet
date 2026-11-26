import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

let DatabaseSync = null;
try {
  const sqliteMod =
    process.getBuiltinModule?.('node:sqlite') ||
    createRequire(import.meta.url)('node:sqlite');
  DatabaseSync = sqliteMod?.DatabaseSync || null;
} catch {
  DatabaseSync = null;
}

const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const EXIT_CODE_RE = /Command exited with code\s+(-?\d+)/;
const WAITING_STATUSES = new Set([
  'WAITING',
  'WAITING_FOR_USER',
  'PENDING_APPROVAL',
  'NEEDS_APPROVAL',
  'CORTEX_STEP_STATUS_WAITING'
]);

function extractUserPrompt(content) {
  const str = String(content || '');
  const m = USER_REQ_RE.exec(str);
  const raw = m ? m[1] : str;
  return raw.replace(/\s+/g, ' ').trim().slice(0, 42);
}

function unwrapArg(val) {
  if (val == null) return '';
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
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
    const p = String(unwrapArg(args.Path || args.path || args.TargetFile) || '');
    return p ? path.basename(p).slice(0, 40) : '';
  }
  if (name === 'run_command') {
    const summary = String(unwrapArg(args.toolSummary) || '').trim();
    if (summary) return summary.slice(0, 32);
    const cmd = String(unwrapArg(args.CommandLine) || '').replace(/\s+/g, ' ').trim();
    return cmd.slice(0, 28);
  }
  if (name === 'invoke_subagent') {
    return String(unwrapArg(args.Role || args.TypeName) || '').slice(0, 28);
  }
  if (name === 'search_web' || name === 'grep_search' || name === 'find_by_name') {
    return String(unwrapArg(args.query || args.Query || args.Pattern) || '').slice(0, 28);
  }
  if (name === 'ask_question') {
    return '等待你选择确认';
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

function needsFeedbackApproval(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const name = String(toolCall.name || '');
  const args = toolCall.args;
  if (!args || typeof args !== 'object') return null;

  if (name === 'ask_question') {
    return { immediate: true, tool: name, detail: '等待你选择确认' };
  }

  const bypass = unwrapArg(args.BypassSandbox);
  if (bypass === true || String(bypass).toLowerCase() === 'true') {
    return {
      immediate: false,
      tool: name || 'run_command',
      detail: extractToolDetail(toolCall) || '沙盒外命令授权'
    };
  }

  const artMeta = unwrapArg(args.ArtifactMetadata);
  if (artMeta && typeof artMeta === 'object' && artMeta.RequestFeedback === true) {
    return {
      immediate: false,
      tool: name || 'write_file',
      detail: extractToolDetail(toolCall) || '待你确认计划'
    };
  }

  return null;
}

function readStepStatusFromBlob(blob) {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    let tag = 0;
    let shift = 0;
    let b = 0;
    while (pos < len) {
      b = buf[pos++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return null;
    }
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let val = 0;
      shift = 0;
      while (pos < len) {
        b = buf[pos++];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) return null;
      }
      if (field === 4) return val;
    } else if (wire === 2) {
      let slen = 0;
      shift = 0;
      while (pos < len) {
        b = buf[pos++];
        slen |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) return null;
      }
      if (slen < 0 || pos + slen > len) break;
      pos += slen;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return null;
}

export class TranscriptWatcher extends EventEmitter {
  /**
   * Tails Antigravity brain transcripts and read-only SQLite step status in real time.
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
    this._convRoots = [...new Set(this._brainRoots.map((r) => path.join(path.dirname(r), 'conversations')))];
    this._offsets = new Map();
    this._buffers = new Map();
    this._primaryConvs = new Set();
    this._primaryConvIds = new Set();
    this._trackedFiles = new Set();
    this._dbStamps = new Map();
    this._dbSchema = new Map();
    this._lastToolByConv = new Map();
    this._waitingConvs = new Map();
    this._pendingAuthTimers = new Map();
    this._lastDiscoveryAt = 0;
    this._lastDbPollAt = 0;
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
    this._lastDbPollAt = 0;
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
    for (const timer of this._pendingAuthTimers.values()) {
      clearTimeout(timer);
    }
    this._pendingAuthTimers.clear();
  }

  _clearPendingAuth(fullConvId) {
    const t = this._pendingAuthTimers.get(fullConvId);
    if (t) {
      clearTimeout(t);
      this._pendingAuthTimers.delete(fullConvId);
    }
  }

  _emitWaitingAuth(fullConvId, tool, detail, origin = 'transcript') {
    this._clearPendingAuth(fullConvId);
    if (this._waitingConvs.has(fullConvId)) return;
    this._waitingConvs.set(fullConvId, {
      origin,
      tool: tool || '',
      detail: detail || ''
    });
    this.emit('activity', {
      origin,
      event: 'WaitingAuth',
      tool: tool || '',
      detail: detail || '等待你的授权确认',
      tokens: 0,
      conv: fullConvId.slice(0, 8),
      ts: Date.now()
    });
  }

  _resolveWaitingAuth(fullConvId, origin = 'transcript') {
    this._clearPendingAuth(fullConvId);
    if (!this._waitingConvs.has(fullConvId)) return;
    this._waitingConvs.delete(fullConvId);
    this.emit('activity', {
      origin,
      event: 'AuthResolved',
      conv: fullConvId.slice(0, 8),
      ts: Date.now()
    });
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
          const fullId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
          this._primaryConvIds.add(fullId);
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

  _pollDatabases(now) {
    if (!DatabaseSync) return;

    for (const convRoot of this._convRoots) {
      if (!fs.existsSync(convRoot)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(convRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
        const fullConvId = entry.name.slice(0, -3);
        if (this._primaryConvIds.size > 0 && !this._primaryConvIds.has(fullConvId)) {
          continue;
        }

        const dbPath = path.join(convRoot, entry.name);
        const walPath = `${dbPath}-wal`;
        let dbStat;
        try {
          dbStat = fs.statSync(dbPath);
        } catch {
          continue;
        }
        let walMtime = 0;
        let walSize = 0;
        try {
          const wStat = fs.statSync(walPath);
          walMtime = wStat.mtimeMs;
          walSize = wStat.size;
        } catch {
          // no wal
        }

        const newestMtime = Math.max(dbStat.mtimeMs, walMtime);
        if (now - newestMtime > 90_000 && !this._waitingConvs.has(fullConvId)) {
          continue;
        }

        const stamp = `${dbStat.mtimeMs}:${dbStat.size}:${walMtime}:${walSize}`;
        if (this._dbStamps.get(dbPath) === stamp) {
          continue;
        }
        this._dbStamps.set(dbPath, stamp);

        this._inspectDbWaiting(dbPath, fullConvId);
      }
    }
  }

  _inspectDbWaiting(dbPath, fullConvId) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=300;');

      let schema = this._dbSchema.get(dbPath);
      if (!schema) {
        const cols = db.prepare('PRAGMA table_info(steps)').all().map((c) => String(c.name || ''));
        const statusCol = cols.find((c) => c === 'status' || c === 'step_status') || null;
        const blobCol = cols.find((c) => c === 'data' || c === 'step' || c === 'payload') || null;
        schema = { statusCol, blobCol };
        this._dbSchema.set(dbPath, schema);
      }

      if (!schema.statusCol && !schema.blobCol) return;

      const selectCols = ['idx', schema.statusCol, schema.blobCol].filter(Boolean).join(', ');
      const rows = db.prepare(`SELECT ${selectCols} FROM steps ORDER BY idx DESC LIMIT 5`).all();
      let isWaiting = false;

      for (const row of rows) {
        if (schema.statusCol) {
          const st = row[schema.statusCol];
          if (st === 9 || WAITING_STATUSES.has(String(st || '').toUpperCase())) {
            isWaiting = true;
            break;
          }
        }
        if (schema.blobCol && row[schema.blobCol]) {
          const stNum = readStepStatusFromBlob(row[schema.blobCol]);
          if (stNum === 9) {
            isWaiting = true;
            break;
          }
        }
      }

      if (isWaiting) {
        const lastTool = this._lastToolByConv.get(fullConvId) || {};
        this._emitWaitingAuth(
          fullConvId,
          lastTool.tool || '',
          lastTool.detail || '等待你的授权确认',
          'db'
        );
      } else if (this._waitingConvs.has(fullConvId)) {
        const existing = this._waitingConvs.get(fullConvId);
        if (existing && existing.origin === 'db') {
          this._resolveWaitingAuth(fullConvId, 'db');
        }
      }
    } catch {
      // ignore busy or incomplete db
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
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

    if (now - this._lastDbPollAt >= 600) {
      this._lastDbPollAt = now;
      this._pollDatabases(now);
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
        const fullId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
        this._primaryConvIds.add(fullId);
        isPrimary = true;
      }
      this._processStep(filePath, obj, isPrimary);
    }
  }

  _processStep(filePath, obj, isPrimary) {
    const stepType = String(obj.type || '');
    const source = String(obj.source || '');
    const status = String(obj.status || '');
    const fullConvId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
    const convId = fullConvId.slice(0, 8);
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

    if (WAITING_STATUSES.has(status.toUpperCase())) {
      const lastTc = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0
        ? obj.tool_calls[obj.tool_calls.length - 1]
        : null;
      const lastTool = this._lastToolByConv.get(fullConvId) || {};
      this._emitWaitingAuth(
        fullConvId,
        lastTc ? String(lastTc.name || '') : (lastTool.tool || ''),
        lastTc ? extractToolDetail(lastTc) : (lastTool.detail || '等待你的授权确认'),
        'transcript'
      );
      return;
    }

    if (stepType === 'USER_INPUT' && source === 'USER_EXPLICIT') {
      this._resolveWaitingAuth(fullConvId, 'transcript');
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
        this._clearPendingAuth(fullConvId);
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
        const toolName = String(lastTc.name || 'tool');
        const toolDetail = extractToolDetail(lastTc);
        this._lastToolByConv.set(fullConvId, { tool: toolName, detail: toolDetail });

        this.emit('activity', {
          origin: 'transcript',
          event: 'ToolStart',
          tool: toolName,
          detail: toolDetail,
          tokens,
          model,
          conv: convId,
          ts: Date.now()
        });

        let authSignal = null;
        for (const tc of toolCalls) {
          authSignal = needsFeedbackApproval(tc);
          if (authSignal) break;
        }
        if (authSignal) {
          if (authSignal.immediate) {
            this._emitWaitingAuth(fullConvId, authSignal.tool, authSignal.detail, 'transcript');
          } else {
            this._clearPendingAuth(fullConvId);
            const timer = setTimeout(() => {
              this._pendingAuthTimers.delete(fullConvId);
              if (!this._stopped) {
                this._emitWaitingAuth(fullConvId, authSignal.tool, authSignal.detail, 'transcript');
              }
            }, 650);
            if (typeof timer.unref === 'function') timer.unref();
            this._pendingAuthTimers.set(fullConvId, timer);
          }
        }
      } else if (content && status === 'DONE') {
        this._resolveWaitingAuth(fullConvId, 'transcript');
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
      const existingWaiting = this._waitingConvs.get(fullConvId);
      if (existingWaiting && existingWaiting.origin === 'transcript') {
        this._resolveWaitingAuth(fullConvId, 'transcript');
      } else {
        this._clearPendingAuth(fullConvId);
      }

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
