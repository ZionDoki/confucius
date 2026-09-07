# 0.4.3-beta.1 发布验收

2026-09-07 UTC，Windows 11、Zotero 10.0.1、Node.js 24。本记录分别记录本地候选包
与发布后的公开 CI 包，不混用两者的二进制摘要。

## 发布范围

基于主干 `5fa177b`，发布分支为 `codex/release-0.4.3-beta.1`。本次包含研读报告
合并、标注附录与导读 Map、可定位引用组件、页面历史索引、schema 错误诊断和
启动后通过 `@` 挂载论文。模型与引用组件的先期验证见
[研读 harness 验收](research-harness-2026-09-07.md)，其验证范围不因发版扩大。

发布前的真实写回检查发现，个人文库 ID 被传给 Zotero 群组查询会抛出异常。
现在报告写回与已有文库工具复用同一文库类型判断，并增加个人库／群组库回归。

## 最终候选包

- `npm test`：802 项通过；typecheck、lint、build、release:check、versions:check
  与 sync-skills:check 通过，没有跳过测试或放宽规则。
- XPI 为 535,369 bytes，SHA-256：
  `714356ec5a15dacfbf29ae01fd0727ba7a07cb654959d94a622de9d9f257e0b9`。
- 根包、全部 workspace、锁文件、运行时版本、XPI manifest 和更新记录均为
  `0.4.3-beta.1`，插件 ID 为 `confucius@zotero.plugin`。
- 构建只生成 `update-beta.json`，没有稳定版 `update.json`；更新 URL 指向
  `v0.4.3-beta.1/confucius.xpi`，SHA-512 与 XPI 一致。
- manifest／更新文件均声明 Zotero 6.999–10.*；本机实测仅覆盖 Zotero 10.0.1。

## 0.4.2 → 候选 Beta 的隔离实测

使用经过 GitHub SHA-256 核验的公开 0.4.2 XPI，在全新的普通 Zotero 配置中创建
合成文献、报告和两版历史。只停止测试进程，不使用个人文库或真实模型凭据。

七组检查通过：

- 公开 0.4.2 正常重启保留报告与历史。
- 通过 AddonManager 安装候选 Beta，旧正文、引用、历史、中文设置与显式 stable
  渠道选择完整保留；没有数据迁移或重新配置模型。
- 实际工作区先选择精读，再从 `@` 列表选择文章，立即切换证据审查，来源保留。
- 继续从 `@` 列表加入第二篇文章并切换综述，来源显示两条；整个过程中没有 PDF
  阅读器。自动化脚本等待一次模板切换完成，再开始下一次输入。
- 引用不存在的标记在报告修订时被拒绝，原报告与 revision 不变。
- 写回先申请审批，允许后创建一条真实 Zotero 笔记；正文的两处引用转为个人文库
  `zotero://select/library/items/…` 链接，未留下原始 `[cite:…]` 标记。
- 候选 Beta 正常重启后为 active、非临时安装；已安装 XPI 的摘要与候选一致。
  旧报告、新报告、挂载来源、配置和写回回执保留。

## 范围与限制

版本顺序、Beta 渠道、关闭不降级、网络失败和下载校验由自动化测试覆盖。
公开渠道发现、下载与重启须在发布后另验，不能用本地候选代替公开资产。
本次没有重新进行整篇原论文的完整研读或真实 PDF 标注写入；模型仍可能重复读页、
产生无依据结论或遇到端点超时。其他系统与 Zotero 版本未现场验证。

原始报告、日志和临时脚本保存在已忽略的 `output/release-0.4.3-beta.1/`。
用户日常使用的 Zotero 配置未安装候选包。

## 公开发布与更新验收

`v0.4.3-beta.1` 指向提交 `cad9b2f6c8116b04e008fdbb6173a5f3e0c33d7e`。
[GitHub Release](https://github.com/ZionDoki/confucius/releases/tag/v0.4.3-beta.1)
于 2026-09-07 03:26:38 UTC 发布，`draft=false`、`prerelease=true`；Latest
继续指向 `v0.4.2`。tag 与公开安装包未被覆盖或移动。

- [tag CI](https://github.com/ZionDoki/confucius/actions/runs/34079551692) 的
  Node.js 22、24 验证与发布任务全部成功；对应的
  [master CI](https://github.com/ZionDoki/confucius/actions/runs/34079551780) 也通过。
- 发布正文与 CHANGELOG 提取结果一致。只有 `confucius.xpi` 和
  `update-beta.json` 两个资产，均为 uploaded；下载大小与 GitHub SHA-256 一致。
- 公开 XPI 为 535,369 bytes，SHA-256：
  `de284d12127b762e1fca93c9edee9308d4aeffb4f5cdbe600239f028f1840434`。
  公开更新 JSON 为 587 bytes；其中的版本、下载链接、兼容声明和 SHA-512 均通过核对。
- 另建一个隔离的普通 0.4.2 安装，明确关闭自动检查和 Zotero 全局自动更新。
  stable 渠道检查不提供 Beta；开启 Beta 后能发现 `0.4.3-beta.1`。
- 使用 Confucius 自身更新器下载、校验并安装公开资产，安装文件摘要与公开 XPI
  相同。正常重启后为非临时 Beta，报告与中文设置保留，显式 beta 偏好与自动检查
  关闭状态保留；再次检查为最新版本，不能重复安装。
- 在已安装的 Beta 中关闭预览渠道，再次正常重启仍是 `0.4.3-beta.1`，显式 stable
  偏好持久保留，不能安装较低版本，验证没有自动降级。

隔离测试进程均正常退出。用户日常 Zotero 的安装和配置未变更。本节验证公开包与
更新流程，不扩大前述模型质量、操作系统或 Zotero 版本的验证范围。
