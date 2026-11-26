---
name: hagemi-pet
description: 打开、调试、更新或自定义「哈Gemi 桌面萌宠」Antigravity 原生插件（右侧 Sidecar 辅助面板、6 套 120 帧透明 WebP 动作与双引擎实时状态同步）。
---

# 哈Gemi 桌面萌宠（Antigravity 原生插件）

本插件将 **DesktopGeminiGirl（哈Gemi）** 的 6 套 120 帧透明 WebP 动作序列与 4 套静态立绘直接集成到 Antigravity 右侧辅助面板（Sidecar Aux Pane），并通过纯 Node.js 零依赖服务实时响应你的对话思考、工具调用、代码编写、报错与完工状态。

## 常用操作

1. **打开右侧辅助面板**
   - 直接在回复中提供一键面板链接：`[哈Gemi 桌面萌宠](sidecar://antigravity-hagemi-pet/hagemi-pet/)`（仅在插件启用并运行时有效）。
   - 或者让用户点击 Antigravity 右侧辅助面板顶部的 `+` 号，选择 **哈Gemi 桌面萌宠**。

2. **在 Windows 桌面上弹出透明置顶悬浮窗**
   - 右侧面板内提供了 **「🖥️ 弹出到桌面」** 一键开关及 **「随插件自启桌面」** 选项（需要本机 Python 带 `PySide6`）。
   - 也可直接运行插件目录下的桌面悬浮窗入口（不依赖面板打开与否，若 Sidecar 正在运行会自动双向联动，否则自动降级直连 `transcript.jsonl`）：
     ```bash
     pythonw ~/.gemini/config/plugins/antigravity-hagemi-pet/desktop/pet.py
     ```

3. **管理插件开关或卸载**
   - 引导用户前往自定义插件管理页：`[哈Gemi 桌面萌宠](customization://antigravity-hagemi-pet)`。

3. **更新或重新部署插件（在源码仓库中运行）**
   ```bash
   node scripts/verify_plugin.mjs
   node scripts/install_plugin.mjs
   ```
   如需卸载：
   ```bash
   node scripts/install_plugin.mjs --uninstall
   ```

4. **双引擎状态同步说明**
   - **实时会话日志与授权状态监控**（`sidecar/transcript-watcher.mjs`）：增量追踪 `~/.gemini/antigravity*/brain/*/.system_generated/logs/transcript.jsonl` 并只读检测会话数据库等待授权状态（`status === 9`），区分主会话与派生子智能体，在需要用户授权或确认时切换为 `awaiting_auth` 琥珀色提醒状态，同时统计思考、工具、完工次数及 Token 消耗。
   - **生命周期 Hooks**（`hooks.json` + `hooks/emit.mjs`）：在 `SessionStart`、`PreInvocation`、`PostToolUse`、`PostInvocation`、`Stop` 触发时通过本地 UDP 端口 `39485` 零阻塞推送，不注册 `PreToolUse`，绝不干涉工具权限策略。
