# 0.4.3-beta.2 发布验收

2026-09-07 UTC，macOS 26.6.2、Zotero 10.0.1、Node.js 23.10.0。
本地候选包与公开 CI 包分别记录，不要求二进制摘要相同。

## 发布范围

基于主干 `e6e3a87bee5b67fb2fae7497ed8b415659e67f24`，发布分支为
`codex/release-0.4.3-beta.2`。包含每请求有限重试、CLI 终止恢复、标注颜色基准、
批次和可信来源、跨任务/Agent 修改删除、阅读器批次筛选，以及任务末尾的逐条
记忆审批。开发期详细回归见
[请求恢复、标注批次与记忆审批验收](request-recovery-batches-memory-2026-09-07.md)。

## 候选包检查

- `npm test`：828 项通过，零失败、跳过；typecheck、lint、build、release:check、
  versions:check 与 sync-skills:check 通过。
- 根包、全部 workspace、锁文件、`CONFUCIUS_VERSION`、XPI manifest 与更新记录
  均为 `0.4.3-beta.2`，插件 ID 为 `confucius@zotero.plugin`。
- XPI 大小为 551,446 bytes，SHA-256：
  `415f5176f2c616645928d74a82f3f707b76758c44ec0a5dbe1c10b1b5c073b90`。
- 构建仅生成 `update-beta.json`，没有稳定 `update.json`；下载地址指向
  `v0.4.3-beta.2/confucius.xpi`，SHA-512 与 XPI 一致。
- manifest 与更新文件均声明 Zotero 6.999–10.*，本轮实测为 Zotero 10.0.1。

## Beta 1 → Beta 2 隔离升级

旧包来自公开 `v0.4.3-beta.1` Release，大小与 GitHub SHA-256 核验通过：
`de284d12127b762e1fca93c9edee9308d4aeffb4f5cdbe600239f028f1840434`。
测试只创建合成数据，未使用个人文库或真实模型凭据；测试配置不强制覆盖待迁移
记忆偏好，避免 `user.js` 在重启时干扰实际持久化。

九项检查全部通过：

1. 公开 Beta 1 正常安装，为非临时插件。
2. Beta 1 重启保留任务、原生标注、已存记忆和待审批提案。
3. 通过 AddonManager 安装 Beta 2，正常重启后版本正确。
4. 原任务标题、标注评论、已存记忆和待审批提案保持。
5. 旧 `auto` 记忆偏好迁移为 `review`，升级本身不新增记忆。
6. 旧标注归为原有标注，不推测批次。
7. 显式 Beta 渠道和关闭自动检查的偏好保持。
8. 旧提案升级后能逐条批准；重复批准只写入一条。
9. Beta 2 再次重启后批准状态和已存记忆保持。

候选包另通过 22 项真实 Zotero 标注、阅读器与记忆审批检查，入口为
`node --import tsx scripts/live-annotation-batches.mjs`。覆盖颜色换色、跨 Agent
宿主权限、页面/侧栏同步、历史多选、原生搜索交集、任务末尾按钮、重启及停用。

## 发布与验证边界

Beta 发布配置为 `prerelease=true`、`make_latest=false`，稳定版 Latest 应保持
`v0.4.2`。公开渠道下载和最终 CI 安装包须在推送 tag 后核验；本节候选结果不能
代替公开资产验收。

真实跨 Agent 操作使用合成执行身份调用宿主。没有对真实服务商故障、CLI 内部
重试或计费进行故障注入；Windows、Linux、其他 Zotero 版本及第三方阅读器扩展
组合未重新实测。旧版升级、当前功能验收与模型质量是独立范围。

临时脚本、日志和隔离文库保存在已忽略的 `output/release-0.4.3-beta.2/`。

## 公开发布与更新验收

`v0.4.3-beta.2` 指向提交 `ac856e5e35077a058fc3db09830db79dd9b7b056`。
[GitHub Release](https://github.com/ZionDoki/confucius/releases/tag/v0.4.3-beta.2)
于 2026-09-07 11:12:10 UTC 发布，`draft=false`、`prerelease=true`；Latest
保持 `v0.4.2`。发布后未移动 tag，也未替换公开资产。

- [tag CI](https://github.com/ZionDoki/confucius/actions/runs/34115201246) 的
  Node.js 22、24 验证与发布任务均成功；对应
  [master CI](https://github.com/ZionDoki/confucius/actions/runs/34115201252) 通过。
- 发布正文与 CHANGELOG 提取结果完全一致。仅有 `confucius.xpi` 和
  `update-beta.json` 两个资产，均为 uploaded，下载大小和 GitHub SHA-256 一致。
- 公开 XPI 为 551,970 bytes，SHA-256：
  `2403afc7b67f1bd007f30ffe5726d01a14b46f2be6aa2cd27f3ec9b42a1b2584`。
  更新 JSON 为 587 bytes；版本、下载地址、兼容范围及 SHA-512 与公开 XPI 对应。
- 另建普通 Beta 1 隔离安装，运行真实 Confucius 更新器。关闭 Beta 渠道时不提供
  Beta 2；开启后发现 `0.4.3-beta.2`，下载、校验并安装成功。
- 实际安装文件摘要与公开 GitHub 资产一致。正常重启后为非临时 Beta 2，任务、
  原生标注、已存记忆和待审批提案保留；`auto` 记忆偏好转为逐条 review。
- 旧提案批准及重复点击只新增一条记忆，再次重启后批准状态保持。
- 更新器再次检查为已是最新版本，不提供重复安装；关闭 Beta 渠道后不提供降级，
  再次重启仍是 Beta 2，显式 stable 偏好持久保留。

公开更新脚本的 16 项检查全部通过，隔离测试进程已退出。此节只扩展公开安装包
与更新流程的证据，不扩大模型故障、操作系统或 Zotero 版本的验证范围。
