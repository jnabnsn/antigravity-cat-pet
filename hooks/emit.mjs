import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';

const PET_HOST = '127.0.0.1';
const PET_PORT = Number(process.env.HAGEMI_PET_UDP_PORT || 39485);
const SENSITIVE_PATTERN = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

function readStdinText() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function summarizeToolTarget(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  const name = String(toolName || '').toLowerCase();

  const rawPath = args.Path || args.path || args.file_path || args.AbsolutePath || args.TargetFile;
  if (rawPath) {
    return path.basename(String(rawPath)).slice(0, 48);
  }
  if (args.toolSummary) {
    return String(args.toolSummary).replace(/\s+/g, ' ').trim().slice(0, 48);
  }
  if (name === 'call_mcp_tool' && args.ServerName && args.ToolName) {
    return `${args.ServerName}/${args.ToolName}`.slice(0, 48);
  }
  if (args.CommandLine) {
    const cmd = String(args.CommandLine).replace(/\s+/g, ' ').trim();
    if (SENSITIVE_PATTERN.test(cmd)) return '[command redacted]';
    return cmd.slice(0, 40);
  }
  if (args.query || args.Query) {
    return String(args.query || args.Query).replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  if (args.Role && args.TypeName) {
    return `${args.TypeName}: ${args.Role}`.slice(0, 48);
  }
  return '';
}

function main() {
  const raw = readStdinText();
  let eventData = {};
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        eventData = parsed;
      }
    } catch {
      eventData = {};
    }
  }

  const fallbackName = process.argv[2] || 'Unknown';
  const hookEvent = String(eventData.hookEventName || fallbackName);
  const toolCall = eventData.toolCall && typeof eventData.toolCall === 'object' ? eventData.toolCall : {};
  const toolName = String(toolCall.name || '');
  const detail = summarizeToolTarget(toolName, toolCall.args);
  const errorMsg = String(eventData.error || '').slice(0, 120);
  const reason = String(eventData.terminationReason || '');
  const lastInput = String(eventData.lastUserInput || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const modelName = String(eventData.modelName || '');
  const convId = String(eventData.conversationId || '').slice(0, 8);

  const output = hookEvent === 'Stop' ? '{"decision":"stop"}\n' : '{}\n';
  process.stdout.write(output);

  const payload = JSON.stringify({
    event: hookEvent,
    tool: toolName,
    detail,
    error: errorMsg,
    reason,
    prompt: lastInput,
    model: modelName,
    conv: convId,
    ts: Date.now()
  });

  const buf = Buffer.from(payload.slice(0, 3800), 'utf8');
  const sock = dgram.createSocket('udp4');
  const timer = setTimeout(() => {
    try { sock.close(); } catch {}
  }, 80);
  timer.unref();

  try {
    sock.send(buf, PET_PORT, PET_HOST, () => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
    });
  } catch {
    clearTimeout(timer);
    try { sock.close(); } catch {}
  }
}

main();
