# 0.5.1-beta.1 发布验收

## 范围与环境

- 日期：2026-09-29（UTC）。版本 `0.5.1-beta.1`，tag `v0.5.1-beta.1`。
- 源码为该 tag 的发布提交，基于 `f67231c`，包含缺总任务索引时的自动恢复修复。
- 环境：macOS、Zotero 10.0.4、Node.js 23.10.0；普通 XPI 安装、隔离配置与合成文库。
- 模型回复使用本机确定性服务，无个人文库、凭据或付费模型调用。
- 本记录在打 tag 前写入；候选验收与发布后原始 CI 包的在线验收分开记录。
  [此前开发验证](runtime-recovery-2026-09-29.md) 使用不同安装包，不能替代本次结果。

## 自动检查与产物

`npm test` 共 1,179 项通过，零失败、取消和跳过，其中存储专项 24 项。
`npm run typecheck`、`npm run lint`、`npm run build`、`npm run versions:check`、
`npm run sync-skills:check` 均通过。根包、8 个 workspace、lockfile 和协议版本一致。
`npm run release:check -- v0.5.1-beta.1` 通过，发布正文由 CHANGELOG 唯一条目提取。

| 本地候选产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `confucius.xpi` | 713660 | `8c5f1b183e2c7e0861fe6ebea30994dbfc5982d87e26e69d1dc639e69a33a898` |
| `update-beta.json` | 587 | `4997453ab5a1214addc4ce1245abc9b83830477dde7d896562ec616ec4a5c296` |

构建从干净输出目录开始，无稳定渠道的 `update.json`。核对 manifest 的版本、
`confucius@zotero.plugin`、兼容范围 `6.999–10.*`，以及更新 JSON 的版本、tag
下载地址、兼容范围和实际 XPI 的 SHA-512。兼容范围沿用既有声明；本次实机仅覆盖
Zotero 10.0.4。CI 构建的 ZIP 摘要需独立核对，不假定与本地包相同。

## 报错后的自动恢复

`scripts/live-runtime-recovery.mjs` 将未修改的公开 `0.5.0` 安装到隔离配置，
建立缺总任务索引的旧目录，包含可读历史、损坏会话索引、中文草稿与标题备份、
工作笔记、报告、删除标记和空子目录。旧包在启动时实际报出
`Existing history has no task index; migration was not activated as an empty state`。

通过 Zotero AddonManager 正常安装候选包后，16 项检查全部通过：

- 自动恢复可读及损坏索引下的任务；不导入空目录或已删除任务。
- 恢复原标题、中文草稿、完整历史、工作笔记和报告关联。
- 恢复期间不调用模型；新任务能正常发送消息并完成。
- 原目录逐文件 SHA-256 不变，校验备份与原始文件字节一致。
- 完整退出并重启后不重复导入，新任务和新草稿仍在，历史仍可读。
- 删除恢复的任务后，旧源文件与恢复备份仍完整保留。
- 新旧安装包均为普通安装，实际安装字节与指定 XPI 摘要一致。

首次扩展升级验收脚本时，错误地断言旧版创建空任务的 RPC 会拒绝；实际错误保存在
启动存储状态。改为检查该实际错误后，用全新隔离配置完成上述验收，产品代码未因
这次脚本断言而修改。首次日志与最终结果均保留在忽略目录内。

复现（先构建并准备原始旧包）：

```sh
node --import tsx scripts/live-runtime-recovery.mjs \
  output/release-0.5.1-beta.1/candidate-recovery \
  apps/zotero-addon/.scaffold/build/confucius.xpi \
  output/release-0.5.0/public/confucius.xpi
```

## 正常数据升级与热更新

旧安装包已与 GitHub 附件的大小和 SHA-256 核对：

| 旧版 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `0.5.0` | 709772 | `ce4eb3ba661788047e9edddbac28c4040067bd5210b76e85a0656e14d82eaf2c` |
| `0.5.0-beta.6` | 708242 | `ffa8d61b20079551d1be1d64c64023fafc099975f83d4d1d333a148034285866` |

`scripts/live-release-upgrade.mjs` 用旧包生成真实 Zotero 笔记、PDF 标注、报告修订、
多窗口历史、记忆、待审批提案和已消耗运行预算，再正常升级与多次重启。

| 升级到候选包 | 检查数 | 保留原始历史文件数 | 结果 |
| --- | ---: | ---: | --- |
| `0.5.0 → 0.5.1-beta.1` | 20 | 28 | 通过 |
| `0.5.0-beta.6 → 0.5.1-beta.1` | 26 | 40 | 通过 |

中文草稿、任务来源分组、报告的两个修订、标注、记忆、提案和预算均保留。
原始历史文件逐字节一致；升级不自行恢复模型，显式继续后复用已完成的写入，
不重复创建笔记或重置额度。Beta 6 场景还核对了文献选择、子任务及其 trace。

`scripts/live-update-window.mjs` 通过 7 项热更新检查：同一进程恢复工作区、所选
会话、最新草稿、更新页和折叠侧栏；再次更新仍能恢复；关闭的窗口保持关闭。
实际安装返回 `restartRequired=false`，并区分已生效与等待重启的界面状态。
该脚本使用本地 XPI 服务，只证明热更新行为，不充当公开在线发现验收。

## 公开包验收方式

发布 CI 在 Node.js 22、24 验证，并将完整附件作为 prerelease 公开，不能成为 Latest。
连续三次匿名发布列表、资产 API 下载和浏览器下载校验失败时，自动撤回草稿。

发布后下载原始 CI 附件到 `output/release-0.5.1-beta.1/public/`，用
`release-assets.mjs --public` 独立核对。恢复脚本增加末尾 `--public` 参数，便会在
已实际报错的原版 0.5.0 内调用其原有更新器，经真实 GitHub 下载、校验、安装；
不能修改旧版更新器或伪造发现响应。正常研究数据另用 `live-release-upgrade.mjs`
的 `--public` 模式验收，渠道与禁止降级另由 `live-legacy-update.mjs` 验证。
这些发布后步骤的结果不以本节流程代替。

## 已知边界

Windows / POSIX 路径、损坏和缺失文件、删除／清理标记、已有本机任务优先级、
trace 与完整回答去重、分阶段中断重试由自动测试覆盖。Windows 本机、Linux、
其他 Zotero 版本、真实模型及外部 Codex/Kimi 执行未重新实测。

没有本地副本的内容和执行检查点不能凭空重建。恢复任务不继承旧执行授权，
不自动重放工具。无法读取文件或校验备份时保留未激活状态并在下次重试；不将
真实 I/O 错误视为可以清空的数据。降级不执行反向数据迁移。

原始日志、JSON 报告、截图及隔离配置位于已忽略的 `output/` 和 `.scaffold/`；
本记录不包含机器绝对路径、用户资料或凭据。
