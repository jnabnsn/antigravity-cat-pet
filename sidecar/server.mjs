import http from 'node:http';
import dgram from 'node:dgram';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptWatcher } from './transcript-watcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(PLUGIN_ROOT, 'assets');
const DYNAMIC_DIR = path.join(ASSETS_DIR, 'dynamic_actions');
const AVATARS_DIR = path.join(ASSETS_DIR, 'avatars');
const WEB_INDEX_PATH = path.join(PLUGIN_ROOT, 'web', 'index.html');
const DESKTOP_SCRIPT_PATH = path.join(PLUGIN_ROOT, 'desktop', 'pet.py');

const IS_SIDECAR = process.env.HAGEMI_PET_SIDECAR === '1' || Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 39486);
const UDP_PORT = Number(process.env.HAGEMI_PET_UDP_PORT || 39485);
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

const DATA_DIR = process.env.PLUGIN_DATA || path.join(os.homedir(), '.antigravity-hagemi-pet');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const RUNTIME_META_PATHS = [
  ...new Set([
    path.join(os.homedir(), '.antigravity-hagemi-pet', 'runtime.json'),
    path.join(DATA_DIR, 'runtime.json')
  ])
];

const ACTION_DEFINITIONS = [
  { key: 'idle', file: '待机呼吸休闲', title: '待机呼吸', loop: true, badge: '待命中 · 观察代码', category: 'idle' },
  { key: 'thinking', file: '工作状态-思考冒泡', title: '思考冒泡', loop: true, badge: 'Antigravity · 思考中', category: 'thinking' },
  { key: 'coding', file: '写代码', title: '疯狂写码', loop: true, badge: '工作中 · 写代码', category: 'working' },
  { key: 'happy', file: '点击回应-开心跃动', title: '开心跃动', loop: false, badge: '心情超好 · 跃动中', category: 'celebrate' },
  { key: 'shocked', file: '被吓一跳', title: '被吓一跳', loop: false, badge: '警告 · 吓了一跳', category: 'error' },
  { key: 'dangling', file: '被鼠标拖拽悬空反馈', title: '悬空挣扎', loop: true, badge: '被拎起来啦！', category: 'dragged' }
];

const STATIC_AVATARS = [
  { key: 'idle', file: 'avatar_default.png', title: '自信傲娇' },
  { key: 'thinking', file: 'avatar_bust.png', title: '呆萌思考' },
  { key: 'coding', file: 'avatar_bust.png', title: '专注写码' },
  { key: 'happy', file: 'avatar_relieved.png', title: '元气开心' },
  { key: 'shocked', file: 'avatar_shocked.png', title: '抱头震惊' },
  { key: 'dangling', file: 'avatar_shocked.png', title: '悬空慌张' }
];

const TOOL_FRIENDLY_NAMES = {
  read_file: '读文件',
  view_file: '看代码',
  write_file: '写新文件',
  edit_file: '改代码',
  replace_file_content: '改代码',
  multi_replace_file_content: '批量改代码',
  run_command: '跑终端',
  search_web: '查资料',
  grep_search: '搜代码',
  find_by_name: '找文件',
  invoke_subagent: '派分身',
  run_workflow: '跑工作流',
  ask_question: '向你确认',
  generate_image: '画插图'
};

const CODING_TOOLS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'run_command'
]);

const POKE_LINES = [
  '别戳啦，哈Gemi 的猫耳都要歪掉了喵！(≧▽≦)',
  '哼，写代码的时候不要随便捏本小姐！该喂 Token 了吧？',
  '嘿嘿，好痒呀~ 今天的代码也要一次通过哦 ♡',
  '被你发现了！本 Gemini 娘正在后台偷偷盯着你的 Bug 呢~',
  '在呢在呢！随时帮你同步 Antigravity 的一举一动喵！'
];

const FEED_LINES = [
  '啊呜啊呜~ 投喂高质量 Token 最幸福啦！算力满满喵✨',
  '咕噜咕噜…吃饱 Token 就帮你把 Bug 通通抓出来！',
  '真香！哈Gemi 能量 +100%，继续陪你写代码~'
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function loadPreferences() {
  const defaults = {
    fps: 14,
    renderMode: 'dynamic',
    showBubbles: true,
    desktopAutoStart: true
  };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          fps: Math.max(8, Math.min(24, Number(parsed.fps) || 14)),
          renderMode: parsed.renderMode === 'static' ? 'static' : 'dynamic',
          showBubbles: parsed.showBubbles !== false,
          desktopAutoStart: parsed.desktopAutoStart !== false
        };
      }
    }
  } catch {
    // ignore
  }
  return defaults;
}

function savePreferences(prefs) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

function loadActionsCatalog() {
  const dynamic = {};
  for (const def of ACTION_DEFINITIONS) {
    const jsonPath = path.join(DYNAMIC_DIR, `${def.file}.json`);
    const webpPath = path.join(DYNAMIC_DIR, `${def.file}.webp`);
    if (!fs.existsSync(jsonPath) || !fs.existsSync(webpPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      dynamic[def.key] = {
        key: def.key,
        title: def.title,
        loop: def.loop,
        badge: def.badge,
        category: def.category,
        frameWidth: Number(meta.FrameWidth) || 640,
        frameHeight: Number(meta.FrameHeight) || 360,
        columns: Number(meta.Columns) || 8,
        rows: Number(meta.Rows) || 15,
        frameCount: Number(meta.FrameCount) || 120,
        baseFps: Number(meta.SampleFps) || 12,
        spriteUrl: `./assets/dynamic_actions/${encodeURIComponent(`${def.file}.webp`)}`
      };
    } catch {
      // ignore invalid json
    }
  }

  const avatars = {};
  for (const av of STATIC_AVATARS) {
    const avPath = path.join(AVATARS_DIR, av.file);
    if (fs.existsSync(avPath)) {
      avatars[av.key] = {
        key: av.key,
        title: av.title,
        url: `./assets/avatars/${encodeURIComponent(av.file)}`
      };
    }
  }

  return { dynamic, avatars };
}

function loadSidecarPreloadJs() {
  const home = os.homedir();
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR
      ? path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
      : null,
    path.join(home, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch {
      // ignore
    }
  }
  return '// sidecar preload unavailable in standalone mode\n';
}

const PRELOAD_JS = loadSidecarPreloadJs();
const ACTIONS_CATALOG = loadActionsCatalog();

let cachedHtml = null;
let cachedHtmlMtime = 0;

function getRenderedHtml() {
  if (!fs.existsSync(WEB_INDEX_PATH)) return null;
  const st = fs.statSync(WEB_INDEX_PATH);
  if (cachedHtml && cachedHtmlMtime === st.mtimeMs) {
    return cachedHtml;
  }
  let html = fs.readFileSync(WEB_INDEX_PATH, 'utf8');
  html = html.replace(
    /<script\s+src="\.?\/preload\.js"><\/script>/i,
    () => `<script>${PRELOAD_JS.replace(/<\/script/gi, '<\\/script')}</script>`
  );
  cachedHtml = html;
  cachedHtmlMtime = st.mtimeMs;
  return cachedHtml;
}

const petState = {
  state: 'idle',
  action: 'idle',
  loop: true,
  seq: 1,
  stateExpiresAt: 0,
  bubble: '哈Gemi 已接入 Antigravity 啦喵~ 今天写什么神仙代码？',
  bubbleUntil: Date.now() + 6500,
  badge: 'Antigravity · 待命中',
  stats: {
    think: 0,
    tool: 0,
    done: 0,
    tokens: 0,
    pets: 0,
    auth: 0
  },
  watcher: {
    trackedCount: 0,
    udpActive: false,
    udpPort: UDP_PORT,
    statusText: '正在初始化实时监控…'
  },
  preferences: loadPreferences(),
  recentEvents: []
};

const sseClients = new Set();

let desktopProc = null;
let desktopLastError = '';
let cachedPythonExe;

function findPythonGuiExecutable() {
  if (cachedPythonExe !== undefined) return cachedPythonExe;

  const candidates = [];
  if (process.env.HAGEMI_PYTHON) {
    candidates.push(process.env.HAGEMI_PYTHON);
  }
  if (process.platform === 'win32') {
    const localPyRoot = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
    try {
      for (const dir of fs.readdirSync(localPyRoot)) {
        candidates.push(path.join(localPyRoot, dir, 'pythonw.exe'));
        candidates.push(path.join(localPyRoot, dir, 'python.exe'));
      }
    } catch {
      // ignore
    }
    try {
      const res = spawnSync('where.exe', ['pythonw'], { encoding: 'utf8', timeout: 1500 });
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const p = line.trim();
          if (p) candidates.push(p);
        }
      }
    } catch {
      // ignore
    }
    candidates.push('pythonw.exe', 'python.exe');
  } else {
    candidates.push('python3', 'python');
  }

  for (const exe of candidates) {
    try {
      if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
      const probeExe =
        process.platform === 'win32' && exe.toLowerCase().endsWith('pythonw.exe') && fs.existsSync(exe.replace(/pythonw\.exe$/i, 'python.exe'))
          ? exe.replace(/pythonw\.exe$/i, 'python.exe')
          : exe;
      const check = spawnSync(probeExe, ['-c', 'import PySide6'], { stdio: 'ignore', timeout: 2500 });
      if (check.status === 0) {
        cachedPythonExe = exe;
        return cachedPythonExe;
      }
    } catch {
      // try next
    }
  }

  cachedPythonExe = '';
  return cachedPythonExe;
}

function getDesktopStatus() {
  const running = Boolean(desktopProc && desktopProc.exitCode === null && !desktopProc.killed);
  const available = fs.existsSync(DESKTOP_SCRIPT_PATH) && Boolean(findPythonGuiExecutable());
  return {
    running,
    pid: running ? desktopProc.pid : null,
    available,
    autoStart: petState.preferences.desktopAutoStart !== false,
    lastError: desktopLastError
  };
}

function startDesktopPet() {
  if (desktopProc && desktopProc.exitCode === null && !desktopProc.killed) {
    return { ok: true, alreadyRunning: true, desktop: getDesktopStatus() };
  }
  if (!fs.existsSync(DESKTOP_SCRIPT_PATH)) {
    desktopLastError = '缺少 desktop/pet.py';
    return { ok: false, error: desktopLastError, desktop: getDesktopStatus() };
  }
  const pyExe = findPythonGuiExecutable();
  if (!pyExe) {
    desktopLastError = '未检测到带 PySide6 的 Python 环境';
    return { ok: false, error: desktopLastError, desktop: getDesktopStatus() };
  }

  const boundPort = server.address()?.port ?? PORT;
  const args = [
    DESKTOP_SCRIPT_PATH,
    '--assets-dir',
    ASSETS_DIR,
    '--server',
    `http://127.0.0.1:${boundPort}`,
    '--owner-pid',
    String(process.pid)
  ];
  if (UI_TOKEN) {
    args.push('--token', UI_TOKEN);
  }

  try {
    // Never pass windowsHide: true for GUI pythonw.exe on Windows
    const child = spawn(pyExe, args, {
      cwd: PLUGIN_ROOT,
      detached: false,
      windowsHide: false,
      stdio: 'ignore'
    });
    desktopProc = child;
    desktopLastError = '';
    pushLog('桌面', `已启动桌面悬浮窗 (PID ${child.pid})`);

    child.on('error', (err) => {
      desktopLastError = err?.message || '启动桌面悬浮窗失败';
      if (desktopProc === child) desktopProc = null;
      broadcastState('state');
    });
    child.on('exit', (code) => {
      if (desktopProc === child) desktopProc = null;
      if (code && code !== 0) {
        desktopLastError = `桌面悬浮窗已退出 (code ${code})`;
      }
      broadcastState('state');
    });

    broadcastState('state');
    return { ok: true, desktop: getDesktopStatus() };
  } catch (err) {
    desktopLastError = err?.message || '启动桌面悬浮窗失败';
    desktopProc = null;
    return { ok: false, error: desktopLastError, desktop: getDesktopStatus() };
  }
}

function stopDesktopPet() {
  if (!desktopProc || desktopProc.exitCode !== null || desktopProc.killed) {
    desktopProc = null;
    return false;
  }
  const child = desktopProc;
  desktopProc = null;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  pushLog('桌面', '已关闭桌面悬浮窗');
  broadcastState('state');
  return true;
}

function writeRuntimeMeta(boundPort) {
  const payload = JSON.stringify(
    {
      port: boundPort,
      udpPort: UDP_PORT,
      pid: process.pid,
      uiToken: UI_TOKEN,
      pluginRoot: PLUGIN_ROOT,
      startedAt: Date.now()
    },
    null,
    2
  ) + '\n';

  for (const rp of RUNTIME_META_PATHS) {
    try {
      fs.mkdirSync(path.dirname(rp), { recursive: true });
      fs.writeFileSync(rp, payload, 'utf8');
    } catch {
      // ignore
    }
  }
}

function cleanupRuntimeMeta() {
  for (const rp of RUNTIME_META_PATHS) {
    try {
      if (!fs.existsSync(rp)) continue;
      const meta = JSON.parse(fs.readFileSync(rp, 'utf8'));
      if (meta && Number(meta.pid) === process.pid) {
        fs.unlinkSync(rp);
      }
    } catch {
      // ignore
    }
  }
}

function pushLog(source, message) {
  petState.recentEvents.unshift({
    ts: Date.now(),
    source,
    message: String(message || '').slice(0, 140)
  });
  if (petState.recentEvents.length > 40) {
    petState.recentEvents.length = 40;
  }
}

function getSnapshot() {
  return {
    state: petState.state,
    action: petState.action,
    loop: petState.loop,
    seq: petState.seq,
    stateExpiresAt: petState.stateExpiresAt,
    bubble: petState.bubble,
    bubbleUntil: petState.bubbleUntil,
    badge: petState.badge,
    stats: { ...petState.stats },
    watcher: { ...petState.watcher },
    preferences: { ...petState.preferences },
    desktop: getDesktopStatus(),
    recentEvents: petState.recentEvents.slice(0, 25),
    serverTs: Date.now()
  };
}

function broadcastState(eventType = 'state') {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({ type: eventType, data: getSnapshot() });
  for (const res of sseClients) {
    try {
      res.write(`event: ${eventType}\ndata: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function setPetAction({
  state,
  action,
  loop = true,
  durationMs = 0,
  bubble = '',
  bubbleDurationMs = 5500,
  badge = ''
}) {
  const now = Date.now();
  petState.state = state;
  petState.action = ACTIONS_CATALOG.dynamic[action] ? action : 'idle';
  petState.loop = loop;
  petState.seq += 1;
  petState.stateExpiresAt = durationMs > 0 ? now + durationMs : 0;
  if (badge) petState.badge = badge;
  if (bubble) {
    petState.bubble = bubble;
    petState.bubbleUntil = now + bubbleDurationMs;
  }
  broadcastState('state');
}

function returnToIdle() {
  petState.state = 'idle';
  petState.action = 'idle';
  petState.loop = true;
  petState.seq += 1;
  petState.stateExpiresAt = 0;
  petState.badge =
    petState.stats.tokens > 0
      ? `待命中 · 已炫 ${fmtTokens(petState.stats.tokens)} Tok`
      : 'Antigravity · 待命中';
  broadcastState('state');
}

function handleLiveActivity(payload) {
  const event = String(payload.event || '');
  const origin = String(payload.origin || 'transcript');
  const tool = String(payload.tool || '');
  const detail = String(payload.detail || '');
  const prompt = String(payload.prompt || '');
  const error = String(payload.error || '');
  const tokens = Number(payload.tokens) || 0;

  if (tokens > 0) {
    petState.stats.tokens += tokens;
  }

  if (event === 'WaitingAuth') {
    petState.stats.auth = (petState.stats.auth || 0) + 1;
    const cnTool = TOOL_FRIENDLY_NAMES[tool] || tool || '';
    let bubble = '主人！Antigravity 正在等你点击授权喵~ 🔐';
    if (tool === 'ask_question') {
      bubble = '主人！哈Gemi 有问题需要你确认喵~ 🔐';
    } else if (cnTool) {
      bubble = `主人！需要你授权 ${cnTool} 才能继续喵~ 🔐${detail ? `\n${detail}` : ''}`;
    }
    const badge = cnTool ? `请授权 · ${cnTool}` : 'Antigravity · 等待授权';
    pushLog('授权', `等待确认: ${cnTool || '操作'}${detail ? ` (${detail})` : ''}`);
    setPetAction({
      state: 'awaiting_auth',
      action: 'happy',
      loop: true,
      durationMs: 600_000,
      bubble,
      bubbleDurationMs: 600_000,
      badge
    });
    return;
  }

  if (event === 'AuthResolved') {
    if (petState.state === 'awaiting_auth') {
      pushLog('授权', '主人已响应授权，继续执行~');
      setPetAction({
        state: 'thinking',
        action: 'thinking',
        loop: true,
        durationMs: 60_000,
        bubble: '收到授权！哈Gemi 继续干活喵~',
        bubbleDurationMs: 3500,
        badge: 'Antigravity · 继续执行'
      });
    }
    return;
  }

  if (event === 'Thinking') {
    petState.stats.think += 1;
    const shortPrompt = prompt
      ? (prompt.length > 18 ? `「${prompt.slice(0, 18)}…」` : `「${prompt}」`)
      : '';
    const bubble = shortPrompt ? `收到指令！思考冒泡中…\n${shortPrompt}` : (detail || '哈Gemi 深度思考冒泡中…');
    pushLog('实时', `思考: ${prompt || detail}`);
    setPetAction({
      state: 'thinking',
      action: 'thinking',
      loop: true,
      durationMs: 120_000,
      bubble,
      bubbleDurationMs: 6500,
      badge: 'Antigravity · 深度思考中'
    });
    return;
  }

  if (event === 'ToolStart') {
    petState.stats.tool += 1;
    const cnTool = TOOL_FRIENDLY_NAMES[tool] || tool || '工具';
    const action = CODING_TOOLS.has(tool) ? 'coding' : 'thinking';
    const prefix = origin === 'subagent' ? '分身' : '正在';
    const bubble = detail ? `${prefix}${cnTool}: ${detail}` : `${prefix}执行 ${cnTool}…`;
    pushLog('实时', `工具: ${tool}${detail ? ` (${detail})` : ''}`);
    setPetAction({
      state: 'working',
      action,
      loop: true,
      durationMs: 90_000,
      bubble,
      bubbleDurationMs: 5500,
      badge: `工作中 · ${cnTool}`
    });
    return;
  }

  if (event === 'ToolError' || event === 'Error') {
    pushLog('实时', `异常: ${error || '执行报错'}`);
    setPetAction({
      state: 'error',
      action: 'shocked',
      loop: false,
      durationMs: 9500,
      bubble: error || '吓了一跳！刚才执行报错啦喵！',
      bubbleDurationMs: 6000,
      badge: 'Antigravity · 报错提醒'
    });
    return;
  }

  if (event === 'TurnComplete') {
    petState.stats.done += 1;
    const tokNote = tokens > 0 ? `（本轮消耗 ${fmtTokens(tokens)} Token）` : '';
    pushLog('实时', `完工!${tokens > 0 ? ` +${tokens} tokens` : ''}`);
    setPetAction({
      state: 'celebrate',
      action: 'happy',
      loop: false,
      durationMs: 9500,
      bubble: `搞定啦！快来看看结果喵~ ${tokNote}`,
      bubbleDurationMs: 6500,
      badge: 'Antigravity · 回复完成'
    });
  }
}

function handleHookEvent(payload) {
  const event = String(payload.event || '');
  const tool = String(payload.tool || '');
  const detail = String(payload.detail || '');
  const error = String(payload.error || '');
  const reason = String(payload.reason || '');

  if (event === 'SessionStart') {
    pushLog('Hook', 'SessionStart · 新会话开启');
    setPetAction({
      state: 'celebrate',
      action: 'happy',
      loop: false,
      durationMs: 9000,
      bubble: '新会话开启喵！哈Gemi 已就位，今天也要高效写代码~',
      bubbleDurationMs: 6000,
      badge: 'Antigravity · 新会话'
    });
  } else if (event === 'PreInvocation' && petState.state !== 'thinking') {
    pushLog('Hook', 'PreInvocation · 模型开始推理');
    setPetAction({
      state: 'thinking',
      action: 'thinking',
      loop: true,
      durationMs: 120_000,
      bubble: '深度思考冒泡中喵…',
      bubbleDurationMs: 5500,
      badge: 'Antigravity · 深度思考中'
    });
  } else if (event === 'PostToolUse' && error) {
    const cnTool = TOOL_FRIENDLY_NAMES[tool] || tool || '工具';
    pushLog('Hook', `PostToolUse 报错: ${cnTool}${detail ? ` (${detail})` : ''}`);
    setPetAction({
      state: 'error',
      action: 'shocked',
      loop: false,
      durationMs: 9500,
      bubble: `吓了一跳！${cnTool} 报错啦喵！`,
      bubbleDurationMs: 6000,
      badge: `报错 · ${cnTool}`
    });
  } else if (event === 'PostToolUse') {
    const cnTool = TOOL_FRIENDLY_NAMES[tool] || tool || '工具';
    pushLog('Hook', `PostToolUse: ${cnTool}${detail ? ` (${detail})` : ''}`);
    if (petState.state === 'awaiting_auth') {
      setPetAction({
        state: 'thinking',
        action: 'thinking',
        loop: true,
        durationMs: 60_000,
        bubble: '收到授权，继续执行喵~',
        bubbleDurationMs: 3500,
        badge: 'Antigravity · 继续执行'
      });
    }
  } else if (event === 'Stop' && reason === 'USER_CANCELED') {
    pushLog('Hook', 'Stop (USER_CANCELED)');
    setPetAction({
      state: 'idle',
      action: 'idle',
      loop: true,
      durationMs: 0,
      bubble: '收到，先停下来歇会儿喵~',
      bubbleDurationMs: 4000,
      badge: 'Antigravity · 待命中'
    });
  } else if (event === 'Stop') {
    pushLog('Hook', `Stop (${reason || 'DONE'})`);
  }
}

// Auto-return to idle when timed/one-shot states expire
const stateExpiryTimer = setInterval(() => {
  if (petState.stateExpiresAt > 0 && Date.now() >= petState.stateExpiresAt) {
    returnToIdle();
  }
}, 1000);
if (typeof stateExpiryTimer.unref === 'function') stateExpiryTimer.unref();

// SSE heartbeat every 25s
const sseHeartbeatTimer = setInterval(() => {
  if (sseClients.size === 0) return;
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25_000);
if (typeof sseHeartbeatTimer.unref === 'function') sseHeartbeatTimer.unref();

// Engine 1: Real-time transcript watcher
const watcher = new TranscriptWatcher({ pollIntervalMs: 300 });
watcher.on('status', (info) => {
  petState.watcher.trackedCount = info.trackedCount;
  petState.watcher.statusText = info.message;
  pushLog('系统', info.message);
  broadcastState('state');
});
watcher.on('activity', handleLiveActivity);
watcher.start();

// Engine 2: UDP Hook listener
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('error', (err) => {
  petState.watcher.udpActive = false;
  pushLog('系统', `Hook UDP 端口 ${UDP_PORT} 未绑定 (${err.code || err.message})，实时日志监控仍正常运行`);
  try { udpSocket.close(); } catch {}
});
udpSocket.on('message', (msg) => {
  try {
    const parsed = JSON.parse(msg.toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      handleHookEvent(parsed);
    }
  } catch {
    // ignore malformed UDP packet
  }
});
udpSocket.bind(UDP_PORT, '127.0.0.1', () => {
  petState.watcher.udpActive = true;
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req, urlObj) {
  if (!UI_TOKEN) return true;
  const headerToken = req.headers['x-sidecar-token'];
  const queryToken = urlObj.searchParams.get('token');
  return headerToken === UI_TOKEN || queryToken === UI_TOKEN;
}

function resolveSafeAssetPath(rawRelPath) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(rawRelPath);
  } catch {
    return null;
  }
  const cleanRel = decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(ASSETS_DIR);
  const candidate = path.resolve(resolvedRoot, cleanRel);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/_sidecar/get-conversation-metadata') {
    sendJson(res, 200, {});
    return;
  }

  if (pathname === '/preload.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(PRELOAD_JS);
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      sidecar: IS_SIDECAR,
      port: server.address()?.port ?? PORT,
      udpActive: petState.watcher.udpActive,
      udpPort: UDP_PORT,
      actionsCount: Object.keys(ACTIONS_CATALOG.dynamic).length
    });
    return;
  }

  if (pathname === '/api/actions') {
    sendJson(res, 200, ACTIONS_CATALOG);
    return;
  }

  if (pathname === '/api/state') {
    sendJson(res, 200, getSnapshot());
    return;
  }

  if (pathname === '/api/desktop') {
    if (req.method === 'GET') {
      sendJson(res, 200, getDesktopStatus());
      return;
    }
    if (req.method === 'POST') {
      if (!isAuthorized(req, urlObj)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const action = String(body.action || 'toggle');
        if (action === 'start') {
          const result = startDesktopPet();
          sendJson(res, result.ok ? 200 : 500, { ...result, state: getSnapshot() });
          return;
        }
        if (action === 'stop') {
          stopDesktopPet();
          sendJson(res, 200, { ok: true, desktop: getDesktopStatus(), state: getSnapshot() });
          return;
        }
        if (action === 'toggle') {
          if (getDesktopStatus().running) {
            stopDesktopPet();
            sendJson(res, 200, { ok: true, desktop: getDesktopStatus(), state: getSnapshot() });
          } else {
            const result = startDesktopPet();
            sendJson(res, result.ok ? 200 : 500, { ...result, state: getSnapshot() });
          }
          return;
        }
        if (action === 'set_auto_start') {
          petState.preferences.desktopAutoStart = Boolean(body.autoStart);
          savePreferences(petState.preferences);
          broadcastState('state');
          sendJson(res, 200, { ok: true, desktop: getDesktopStatus(), state: getSnapshot() });
          return;
        }
        sendJson(res, 400, { error: 'Unknown desktop action' });
      } catch (err) {
        sendJson(res, 400, { error: err?.message || 'Invalid JSON' });
      }
      return;
    }
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive'
    });
    res.write(`event: state\ndata: ${JSON.stringify({ type: 'state', data: getSnapshot() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/action') {
    if (!isAuthorized(req, urlObj)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const kind = String(body.type || '');

      if (kind === 'preview') {
        const actionKey = String(body.action || 'idle');
        if (actionKey === 'awaiting_auth') {
          pushLog('预览', '切换状态 -> 等待授权');
          setPetAction({
            state: 'awaiting_auth',
            action: 'happy',
            loop: true,
            durationMs: 12_000,
            bubble: String(body.bubble || '主人！需要你点一下授权才能继续喵~ 🔐\n(示例：沙盒外命令执行确认)'),
            bubbleDurationMs: 12_000,
            badge: 'Antigravity · 等待授权'
          });
        } else {
          const def = ACTION_DEFINITIONS.find((d) => d.key === actionKey) || ACTION_DEFINITIONS[0];
          const bubbleMap = {
            idle: '回到待机呼吸状态喵~ 随时等你吩咐！',
            thinking: '思考冒泡中…让哈Gemi 想想怎么优化这段代码！',
            coding: '哒哒哒——哈Gemi 全速敲键盘写代码中！',
            happy: '耶！开心跃动时间喵✨',
            shocked: '呜哇！！吓本小姐一跳！',
            dangling: '呜哇哇！快把哈Gemi 放下来啦！'
          };
          pushLog('预览', `切换动作 -> ${def.title}`);
          setPetAction({
            state: def.category,
            action: def.key,
            loop: def.loop,
            durationMs: def.key === 'idle' ? 0 : 9500,
            bubble: String(body.bubble || bubbleMap[def.key] || ''),
            bubbleDurationMs: 5000,
            badge: def.badge
          });
        }
      } else if (kind === 'poke') {
        petState.stats.pets += 1;
        const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)];
        pushLog('互动', '戳了一下哈Gemi');
        setPetAction({
          state: 'petted',
          action: 'happy',
          loop: false,
          durationMs: 9500,
          bubble: line,
          bubbleDurationMs: 4800,
          badge: '互动 · 开心回应'
        });
      } else if (kind === 'feed') {
        petState.stats.pets += 1;
        const line = FEED_LINES[Math.floor(Math.random() * FEED_LINES.length)];
        pushLog('互动', '投喂了一次 Token 能量');
        setPetAction({
          state: 'petted',
          action: 'happy',
          loop: false,
          durationMs: 9500,
          bubble: line,
          bubbleDurationMs: 5200,
          badge: '投喂中 · 炫 Token'
        });
      } else if (kind === 'reset_stats') {
        petState.stats = { think: 0, tool: 0, done: 0, tokens: 0, pets: 0, auth: 0 };
        pushLog('系统', '已清空会话统计计数器');
        returnToIdle();
      } else if (kind === 'preferences') {
        if (body.fps !== undefined) {
          petState.preferences.fps = Math.max(8, Math.min(24, Number(body.fps) || 14));
        }
        if (body.renderMode === 'dynamic' || body.renderMode === 'static') {
          petState.preferences.renderMode = body.renderMode;
        }
        if (typeof body.showBubbles === 'boolean') {
          petState.preferences.showBubbles = body.showBubbles;
        }
        savePreferences(petState.preferences);
        broadcastState('state');
      } else {
        sendJson(res, 400, { error: 'Unknown action type' });
        return;
      }

      sendJson(res, 200, { ok: true, state: getSnapshot() });
    } catch (err) {
      sendJson(res, 400, { error: err?.message || 'Invalid JSON' });
    }
    return;
  }

  if (pathname.startsWith('/assets/')) {
    const rel = pathname.slice('/assets/'.length);
    const filePath = resolveSafeAssetPath(rel);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(data);
      }
    });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const html = getRenderedHtml();
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('web/index.html not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

let shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stateExpiryTimer);
  clearInterval(sseHeartbeatTimer);
  watcher.stop();
  stopDesktopPet();
  cleanupRuntimeMeta();
  try { udpSocket.close(); } catch {}
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 400).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, gracefulShutdown);
}

server.listen(PORT, '127.0.0.1', () => {
  const boundPort = server.address()?.port ?? PORT;
  writeRuntimeMeta(boundPort);
  console.error(`[HagemiPet] ${IS_SIDECAR ? 'Sidecar' : 'Standalone'} listening on http://127.0.0.1:${boundPort} (UDP ${UDP_PORT})`);
  if (
    IS_SIDECAR &&
    petState.preferences.desktopAutoStart !== false &&
    process.env.HAGEMI_PET_NO_AUTO_DESKTOP !== '1'
  ) {
    const autoTimer = setTimeout(() => {
      startDesktopPet();
    }, 600);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  }
});
