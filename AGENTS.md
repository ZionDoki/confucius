# AGENTS.md

本文件对在本仓库工作的人工智能代理具有约束力。动手前先读完。

## 硬性要求：涉及前端的变化必须用 Computer Use 查看并测试

凡是会改变用户能看见、能点到、能输入的界面的改动，**必须**使用 Computer Use（本机 `kimi-cu` 桌面操控）打开真实窗口：先截图/观察确认画面，再按真实用户路径点击、输入、提交来测试。

**禁止**只靠读代码、看静态文件、跑单元测试或类型检查就宣称前端做完。没有打开过真实界面，就不能说已经查看或测试过 UI。

### 什么算前端

包括但不限于：

- Chrome 侧栏：`apps/chrome-extension/`（`sidepanel.html`、`sidepanel.js`、`workspace-app.js`、`workspace.css` 等）
- Zotero 工作区与工具栏：`apps/zotero-addon/src/modules/ui/`、`addon/content/workspace.xhtml`、`addon/content/workspace.css`
- Zotero 偏好面板：`addon/content/preferences.xhtml`、`src/modules/preferences/`
- 文案（`addon/locale/**` 中会显示到界面的字符串）、布局、样式、交互、空态、错误态、加载态、审批、记忆面板、会话列表、配对与推送当前标签页

共享状态、共享组件或两端共用的工作区逻辑被改到时，Chrome 侧栏和 Zotero 工作区都要打开测一遍。

### 怎么验收

1. 用 Computer Use 列出窗口、截取当前界面，确认改动出现在真实窗口里，而不是只存在于源码。
2. 端到端走用户路径：点击、输入、提交、切换会话/面板，确认**行为**而不只是外观。
3. 检查相邻流程和边角状态（空态、错误态、配对失败、审批、发送等），主动找回归，不要停在主路径。
4. 布局或样式改动必须看实际窗口尺寸下的效果，不要只看 CSS。
5. 发现问题就修，再 Computer Use 复验。复验通过之前，不得宣称前端完成。

单元测试、`npm test`、`npm run typecheck` 仍然要跑，但它们**不能替代** Computer Use 验收。

Computer Use 不可用时（运行时未安装、无桌面会话、目标窗口打不开），必须在回复里明确写「未能用 Computer Use 打开界面」，并说明用了什么替代手段；**不得假装已经看过 UI**。

### 打开界面

- **Zotero 工作区**：`npm start`（`apps/zotero-addon`，需要本机 Zotero 7+），点 Confucius 工具栏按钮打开工作区；偏好在 Zotero → Settings → Confucius。
- **Chrome 侧栏**：`chrome://extensions` → Load unpacked → `apps/chrome-extension`，打开侧栏，粘贴配对 token 后 Pair。
