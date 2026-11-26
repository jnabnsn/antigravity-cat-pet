# 🎀 哈Gemi 桌面萌宠 — Antigravity 原生插件

**基于 `DesktopGeminiGirl` 动态与立绘素材打造的零依赖纯 Node.js Antigravity 原生插件！**

将元气毒舌 Gemini 娘（**哈Gemi**）直接请进 Google Antigravity 右侧辅助面板（Sidecar Aux Pane）：60 FPS 流畅渲染 120 帧透明 WebP 精灵图与高清立绘差分，实时同步你的思考、写代码、报错与完工状态，并统计当前消耗的 Token。

---

## ✨ 核心特性

- **零第三方依赖 Sidecar（纯 Node.js 标准库）**：无需 `npm install` 即可在 Antigravity 右侧辅助面板运行，随 Antigravity 自动启停。
- **支持双展示形态（右侧辅助面板 + 透明置顶桌面悬浮窗）**：
  - **右侧辅助面板**：在 Antigravity 内置 Sidecar 面板实时展示哈Gemi 动画、事件流、Token 计数，并提供 **「🖥️ 弹出到桌面」** 一键开关。
  - **桌面透明悬浮窗**（`desktop/pet.py`，基于 PySide6）：无边框、透明置顶、支持拎起甩抛物理与屏幕边缘弹回、系统托盘和右键菜单；与 Sidecar 双向实时联动（无 Sidecar 时也可独立直连 `transcript.jsonl` 运行）。
- **6 套 120 帧透明 WebP 动态动作 + 4 套高清静态立绘**：
  - 支持「动态 120 帧」与「静态立绘」一键切换，内置 60 FPS 呼吸微动、Q 弹回弹、拖拽悬空摇摆与飘字粒子。
  - **动作映射**：
    - 💭 收到提问 / 深度思考 → `工作状态-思考冒泡`
    - 💻 修改/编写代码与跑终端 → `写代码`
    - 🎉 回复完成 / 新会话开启 / 戳一戳 / 投喂 Token → `点击回应-开心跃动`
    - ⚡ 命令或工具报错 → `被吓一跳`
    - 🎀 鼠标拖拽悬空 → `被鼠标拖拽悬空反馈`
    - 😌 日常待机 → `待机呼吸休闲`
- **Antigravity 双引擎实时联动**：
  - **实时会话日志追踪**（`sidecar/transcript-watcher.mjs`）：300ms 增量读取 `~/.gemini/antigravity*/brain/*/.system_generated/logs/transcript.jsonl`，自动区分主会话与 Subagent 并实时累加 Token。
  - **原生生命周期 Hooks**（`hooks.json` + `hooks/emit.mjs`）：通过本地 UDP 端口 `39485` 零阻塞推送 `SessionStart`、`PreInvocation`、`PostToolUse`、`PostInvocation`、`Stop` 事件（不注册 `PreToolUse`，不影响任何工具权限确认）。

---

## 🚀 安装与使用

### 1. 一键安装到本机 Antigravity 全局插件目录

```bash
node scripts/install_plugin.mjs
```

安装完成后，Antigravity 会自动发现 `~/.gemini/config/plugins/antigravity-hagemi-pet`。

### 2. 打开右侧辅助面板

- 在 Antigravity 右侧辅助面板点击 `+` 号，选择 **「哈Gemi 桌面萌宠」**；
- 或在对话中点击 Agent 给出的 `[哈Gemi 桌面萌宠](sidecar://antigravity-hagemi-pet/hagemi-pet/)` 快捷胶囊即可打开。

### 3. 本地校验与卸载

```bash
# 运行完整自动化校验（清单、素材、HTTP/SSE、UDP Hook 往返）
node scripts/verify_plugin.mjs

# 卸载已安装的全局插件（不影响源码仓库）
node scripts/install_plugin.mjs --uninstall
```

---

## 📂 插件结构

```text
antigravity-hagemi-pet/
├── plugin.json                    # Antigravity 原生插件清单
├── hooks.json                     # 插件生命周期 Hooks 配置
├── sidecars/hagemi-pet/sidecar.json # Aux Pane Sidecar 描述文件
├── sidecar/
│   ├── server.mjs                 # 纯 Node.js HTTP/SSE/UDP Sidecar 服务
│   └── transcript-watcher.mjs     # 实时 transcript.jsonl 增量监控
├── hooks/emit.mjs                 # 毫秒级零阻塞 Hook UDP 上报脚本
├── web/index.html                 # 自包含 60 FPS Canvas 宠物面板
├── assets/
│   ├── logo.png                   # 插件图标 (256x256 RGBA)
│   ├── avatars/                   # 4 套静态立绘差分
│   └── dynamic_actions/           # 6 套 120 帧透明 WebP 精灵图与元数据
├── rules/AGENTS.md                # 插件规则
├── skills/hagemi-pet/SKILL.md     # 插件运维与交互 Skill
└── scripts/
    ├── install_plugin.mjs         # 全局安装/卸载脚本
    └── verify_plugin.mjs          # 端到端自动化校验脚本
```

---

## 🙏 致谢与协议

- 插件代码基于 MIT 协议开源，详见 [LICENSE](LICENSE)。
- 哈Gemi 动态动作与立绘素材来源及第三方版权致谢详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
