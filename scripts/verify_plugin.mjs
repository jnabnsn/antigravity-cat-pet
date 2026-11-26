#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'displayName',
  'description',
  'logo',
  'suggestedPrompts',
  'version',
  'author',
  'homepage',
  'repository',
  'disabled'
]);

const EXPECTED_ACTIONS = [
  '待机呼吸休闲',
  '工作状态-思考冒泡',
  '写代码',
  '点击回应-开心跃动',
  '被吓一跳',
  '被鼠标拖拽悬空反馈'
];

const EXPECTED_AVATARS = [
  'avatar_default.png',
  'avatar_bust.png',
  'avatar_relieved.png',
  'avatar_shocked.png'
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function verifyStaticFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  for (const key of Object.keys(manifest)) {
    assert(ALLOWED_PLUGIN_KEYS.has(key), `Unexpected plugin.json key: ${key}`);
  }
  assert.equal(manifest.name, 'antigravity-hagemi-pet');
  assert(manifest.logo && fs.existsSync(path.join(ROOT, manifest.logo)), 'plugin.json logo missing');

  const pngHeader = fs.readFileSync(path.join(ROOT, manifest.logo)).subarray(0, 24);
  assert.equal(pngHeader.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'logo must be valid PNG');
  const logoW = pngHeader.readUInt32BE(16);
  const logoH = pngHeader.readUInt32BE(20);
  assert(logoW === logoH && logoW >= 128, `logo must be square >=128px, got ${logoW}x${logoH}`);

  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8'));
  const hookSpec = hooks['antigravity-hagemi-pet'];
  assert(hookSpec, 'Missing hooks.json entry');
  assert(!hookSpec.PreToolUse, 'hooks.json must not register PreToolUse');
  for (const ev of ['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'Stop']) {
    assert(Array.isArray(hookSpec[ev]) && hookSpec[ev].length > 0, `Missing hook event ${ev}`);
  }

  const sidecarManifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'sidecars', 'hagemi-pet', 'sidecar.json'), 'utf8')
  );
  assert.equal(sidecarManifest.has_web_ui, true);
  assert.equal(
    sidecarManifest.ui_config?.views?.[0]?.entrypoint,
    'SIDECAR_UI_ENTRYPOINT_AUX_PANE'
  );
  const serverScript = path.resolve(
    path.join(ROOT, 'sidecars', 'hagemi-pet'),
    sidecarManifest.args[0]
  );
  assert(fs.existsSync(serverScript), `Sidecar script missing: ${serverScript}`);

  for (const name of EXPECTED_ACTIONS) {
    assert(fs.existsSync(path.join(ROOT, 'assets', 'dynamic_actions', `${name}.webp`)), `Missing ${name}.webp`);
    assert(fs.existsSync(path.join(ROOT, 'assets', 'dynamic_actions', `${name}.json`)), `Missing ${name}.json`);
  }
  for (const av of EXPECTED_AVATARS) {
    assert(fs.existsSync(path.join(ROOT, 'assets', 'avatars', av)), `Missing avatar ${av}`);
  }
  assert(fs.existsSync(path.join(ROOT, 'rules', 'AGENTS.md')), 'Missing rules/AGENTS.md');
  assert(fs.existsSync(path.join(ROOT, 'skills', 'hagemi-pet', 'SKILL.md')), 'Missing skills/hagemi-pet/SKILL.md');
  const desktopPy = path.join(ROOT, 'desktop', 'pet.py');
  assert(fs.existsSync(desktopPy), 'Missing desktop/pet.py');

  const pyExe = process.platform === 'win32' ? 'python' : 'python3';
  const pyCompile = spawnSync(pyExe, ['-m', 'py_compile', desktopPy], { encoding: 'utf8' });
  assert.equal(pyCompile.status, 0, `py_compile failed: ${pyCompile.stderr}`);
  const pySmoke = spawnSync(pyExe, [desktopPy, '--smoke-test'], { encoding: 'utf8' });
  assert.equal(pySmoke.status, 0, `desktop/pet.py --smoke-test failed: ${pySmoke.stderr}`);
  assert(pySmoke.stdout.includes('SMOKE_OK'), `Unexpected smoke output: ${pySmoke.stdout}`);
  console.log('[PASS] Static manifests, assets, rule, skill, and desktop pet smoke checks passed.');
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Sidecar server failed to become healthy in time');
}

async function verifyRuntime() {
  const httpPort = await getFreePort();
  const udpPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  const srv = spawn(process.execPath, [path.join(ROOT, 'sidecar', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HAGEMI_PET_SIDECAR: '1',
      HAGEMI_PET_NO_AUTO_DESKTOP: '1',
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(httpPort),
      HAGEMI_PET_UDP_PORT: String(udpPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  srv.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  try {
    const health = await waitForHealth(baseUrl);
    assert.equal(health.ok, true);
    assert.equal(health.actionsCount, 6);
    assert.equal(health.udpActive, true, `UDP listener failed to bind: ${stderrBuf}`);

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert(html.includes('<canvas id="petCanvas">'), 'Missing petCanvas in HTML');

    const actionsRes = await fetch(`${baseUrl}/api/actions`);
    assert.equal(actionsRes.status, 200);
    const actionsData = await actionsRes.json();
    assert.equal(Object.keys(actionsData.dynamic).length, 6);
    assert.equal(Object.keys(actionsData.avatars).length, 6);

    const desktopRes = await fetch(`${baseUrl}/api/desktop`);
    assert.equal(desktopRes.status, 200);
    const desktopData = await desktopRes.json();
    assert.equal(desktopData.available, true, 'Expected desktop pet to be available');
    assert.equal(desktopData.running, false, 'Expected desktop pet not to auto-launch during test');

    const spriteUrl = actionsData.dynamic.idle.spriteUrl.replace(/^\.\//, '/');
    const spriteRes = await fetch(`${baseUrl}${spriteUrl}`);
    assert.equal(spriteRes.status, 200);
    assert.equal(spriteRes.headers.get('content-type'), 'image/webp');
    const spriteBytes = await spriteRes.arrayBuffer();
    assert(spriteBytes.byteLength > 100_000, 'WebP sprite unexpectedly small');

    // Test hook emit -> UDP -> state update for PostToolUse (error) and Stop
    const emitScript = path.join(ROOT, 'hooks', 'emit.mjs');
    const postErr = spawnSync(process.execPath, [emitScript], {
      cwd: ROOT,
      env: { ...process.env, HAGEMI_PET_UDP_PORT: String(udpPort) },
      input: JSON.stringify({
        hookEventName: 'PostToolUse',
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
        error: 'exit status 1'
      }),
      encoding: 'utf8'
    });
    assert.equal(postErr.status, 0);
    assert.deepEqual(JSON.parse(postErr.stdout.trim()), {});

    await new Promise((r) => setTimeout(r, 120));
    const afterErrState = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(afterErrState.action, 'shocked', 'PostToolUse error should trigger shocked action');

    const stopRes = spawnSync(process.execPath, [emitScript], {
      cwd: ROOT,
      env: { ...process.env, HAGEMI_PET_UDP_PORT: String(udpPort) },
      input: JSON.stringify({
        hookEventName: 'Stop',
        terminationReason: 'USER_CANCELED'
      }),
      encoding: 'utf8'
    });
    assert.equal(stopRes.status, 0);
    assert.deepEqual(JSON.parse(stopRes.stdout.trim()), { decision: 'stop' });

    await new Promise((r) => setTimeout(r, 120));
    const afterStopState = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(afterStopState.action, 'idle', 'Stop USER_CANCELED should return to idle');

    // Test POST /api/action
    const postRes = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'preview', action: 'coding' })
    });
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.ok, true);
    assert.equal(postJson.state.action, 'coding');

    const authPreviewRes = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'preview', action: 'awaiting_auth' })
    });
    assert.equal(authPreviewRes.status, 200);
    const authPreviewJson = await authPreviewRes.json();
    assert.equal(authPreviewJson.ok, true);
    assert.equal(authPreviewJson.state.state, 'awaiting_auth');

    console.log('[PASS] Runtime HTTP, WebP assets, Hook UDP round-trip, and /api/action checks passed.');
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (!srv.killed) {
      try { srv.kill('SIGKILL'); } catch {}
    }
  }
}

async function main() {
  verifyStaticFiles();
  await verifyRuntime();
  console.log('[ALL PASS] antigravity-hagemi-pet verification succeeded!');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
