#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PLUGIN_DIR_NAME = 'antigravity-hagemi-pet';
const PLUGINS_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins');
const TARGET_DIR = path.join(PLUGINS_DIR, PLUGIN_DIR_NAME);

const RUNTIME_ITEMS = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'desktop',
  'hooks',
  'sidecars',
  'sidecar',
  'web',
  'rules',
  'skills',
  'scripts'
];

function isSymlinkOrJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeTarget(targetPath) {
  if (!fs.existsSync(targetPath) && !isSymlinkOrJunction(targetPath)) {
    return false;
  }
  if (isSymlinkOrJunction(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      console.error(`[错误] 目标目录正被运行中的 Antigravity Sidecar 进程占用: ${targetPath}`);
      console.error('       请先在 Antigravity 自定义插件页暂时关闭该插件后再试。');
      process.exit(1);
    }
    throw err;
  }
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db' || entry.name === '__pycache__') {
        continue;
      }
      copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(`用法: node scripts/install_plugin.mjs [--uninstall]`);
    return;
  }

  if (args.has('--uninstall')) {
    const removed = removeTarget(TARGET_DIR);
    console.log(removed ? `[完成] 已卸载插件: ${TARGET_DIR}` : `[跳过] 未发现已安装插件: ${TARGET_DIR}`);
    return;
  }

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  if (isSymlinkOrJunction(TARGET_DIR)) {
    fs.unlinkSync(TARGET_DIR);
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  for (const rel of RUNTIME_ITEMS) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(TARGET_DIR, rel);
    if (!fs.existsSync(src)) {
      console.warn(`[警告] 跳过缺失路径: ${rel}`);
      continue;
    }
    copyRecursive(src, dest);
  }

  console.log(`[完成] 已安装哈Gemi 桌面萌宠插件至: ${TARGET_DIR}`);
  console.log('[提示] Antigravity 会自动发现该插件，可在自定义插件页管理或从右侧辅助面板打开。');
}

main();
