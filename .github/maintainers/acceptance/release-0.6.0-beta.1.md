# 0.6.0-beta.1 发布验收

## 范围与环境

- 日期：2026-10-06（UTC）。版本 `0.6.0-beta.1`，tag `v0.6.0-beta.1`。
- 源码为该 tag 的发布提交，基于 `48afd79`；包含 Issue #7 的批注建议审阅、
  多批次卡片／列表与最小化交互，以及上下文、查询和子任务竞态修复。
- 本机环境：macOS、Zotero 10.0.4、Node.js 23.10.0；普通 XPI 安装、隔离配置、
  合成文库和本地确定性回复，不使用个人文库、凭据或付费模型。
- 本记录候选部分在打 tag 前写入。发布后原始 CI 安装包与旧客户端在线升级的
  结果另行追加；候选包测试不能替代公开包验收。

## 自动检查与产物

`npm test` 共 1,230 项通过，零失败、取消和跳过。
`npm run typecheck`、`npm run lint`、`npm run build`、`npm run versions:check`、
`npm run sync-skills:check` 均通过。根包、8 个 workspace、lockfile 与协议版本一致。
`npm run release:check -- v0.6.0-beta.1` 通过，发布正文只从 CHANGELOG 的对应条目提取。

| 本地候选产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `confucius.xpi` | 733037 | `dcf1e943f8ad424a858da4c246f4b95b2279265609f518d981c4cd27db7f0e15` |
| `update-beta.json` | 587 | `9d704a6578c8e00c7d628c6f526f9a8a10909f0b516c859569a85974c1101a84` |

旧构建移至忽略目录后重新构建，输出中没有稳定渠道的 `update.json`。
使用 `release-assets.mjs` 的 `localAssets` 核对 manifest 版本、
`confucius@zotero.plugin`、兼容范围 `6.999–10.*`，以及更新 JSON 的版本、
tag 下载地址、兼容范围和实际 XPI 的 SHA-512。兼容范围沿用既有声明；
本次实机仅覆盖 Zotero 10.0.4。CI 构建的 ZIP 摘要必须独立核对。

## 批注审阅与核心流程

`scripts/live-annotation-review.mjs` 在真实 Zotero PDF 阅读器和工作区中通过 41 项检查：

- Agent 连续提交仅产生待审建议；逐条和跨批次接受只写入选中的原生批注，取得真实 key。
- 拒绝与恢复不写 PDF；无法定位的条目可拒绝和恢复，保留警告且不可接受。
- 胶囊、卡片、列表与按钮可交互；滚轮、位置滑杆、搜索和逐页加载可达全部 240 条。
- 打开浮层不移动输入区；普通、窄屏、暗色模式中浮层位置和按钮对齐正常，无玻璃边缘。
- 处理完成、写入中和切换任务后均可最小化；重开保留所选卡片、搜索、筛选与阅读位置。
- 新批次不打断当前审阅，不加入已有批量选择，不破坏中文输入法组合。
- 过期请求和写入回执不会重新打开浮层或移动后来选择的卡片。
- 完整退出并重启 Zotero 后保留所有批次和回执，不自动重放 PDF 写入。

`scripts/live-subagents.mjs` 记录 25 个条目：1 个环境记录与 24 个行为检查，全部通过。
覆盖并发上限和排队、停止与重试、完整工具输入／回执、迟到分页、中文输入、
筛选与滚动位置、窄屏／高对比、任务切换，以及 2,000 个工具事件的长记录读取。

本次核心竞态脚本另通过 9 项实机检查：当前上下文保存、过期保存保护、查询游标
任务隔离、查询过程中索引修订变化、Unicode 精确读取、Native 窗口切换、持久化时
发生 steering 后保护新状态、随后正常重试，以及窗口和工作笔记跨真实重启保留。
该专项临时脚本与原始报告保留于忽略的 `output/`；对应竞态还由提交中的自动测试覆盖。

## 旧版数据升级与热更新

原始旧包已与 GitHub 附件的大小和 SHA-256 核对，未修改其运行时或版本号：

| 旧版 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `0.5.0` | 709772 | `ce4eb3ba661788047e9edddbac28c4040067bd5210b76e85a0656e14d82eaf2c` |
| `0.5.1-beta.1` | 714254 | `81c2d21e90b11cd199d7821e39dcdce9c022b3aac065f0a3fc2b0cf7daa3a10d` |

`scripts/live-release-upgrade.mjs` 使用旧版创建真实 Zotero 笔记、PDF 标注、报告修订、
多窗口历史、记忆、待审记忆提案和已消耗运行预算，再安装候选包并多次重启。

| 升级到候选包 | 检查数 | 原始历史文件数 | 结果 |
| --- | ---: | ---: | --- |
| `0.5.0 → 0.6.0-beta.1` | 20 | 28 | 通过 |
| `0.5.1-beta.1 → 0.6.0-beta.1` | 26 | 40 | 通过 |

所有原始历史文件逐字节一致。中文草稿、任务来源、笔记与标注、报告的两个修订、
记忆和待审提案、执行与维护预算保留。Beta 升级还验证文献选择、子任务、结果与 trace。
升级不自动调用模型；显式继续复用已经完成的写入，不重复创建笔记或重置额度。

`scripts/live-update-window.mjs` 通过 7 项检查：同一进程恢复工作区、所选任务、
最新草稿、更新页与折叠侧栏；再次安装仍可恢复；已关闭工作区保持关闭。
实际安装返回 `restartRequired=false`，界面区分已生效与等待重启。
该脚本使用本地 XPI 服务，只验证热更新，不充当公开在线发现验收。

复现升级时可用 `ZOTERO_BIN` 指定用于隔离验收的 Zotero 可执行文件；本次为脚本
补充了该入口，默认路径保持原有行为：

```sh
CONFUCIUS_UPGRADE_OLD=output/release-0.5.0/public/confucius.xpi \
  node scripts/live-release-upgrade.mjs
CONFUCIUS_UPGRADE_OLD=output/release-0.5.1-beta.1/public/confucius.xpi \
  node scripts/live-release-upgrade.mjs
CONFUCIUS_UPDATE_OUTPUT=output/release-0.6.0-beta.1/hot-update \
  node scripts/live-update-window.mjs output/release-0.5.1-beta.1/public/confucius.xpi
```

## 边界与未覆盖项

开发审查时运行的旧 `scripts/live-context-memory.mjs` 在 13 项成功后，于
“任务超过热集合上限必须消耗两次维护调用”的旧断言失败。当前既有策略先归档，
再独立提炼和清理，不能用旧脚本对调用次数与立即清理的假设判定。
该次未完成运行的日志和失败报告完整保留，没有算作通过；本次候选验证使用上文
9 项当前上下文检查及完整自动测试，不宣称旧维护脚本已全部通过。

Windows、Linux、其他 Zotero 版本、外部 Codex/Kimi 真实执行及付费模型未复验。
本地确定性模型不证明实际模型建议的内容质量。候选包测试不证明旧客户端已能通过
GitHub 取得公开包，必须完成下节的发布后验收。

## 公开包验收流程

tag 工作流在 Node.js 22、24 验证并构建，先上传 draft 并核对附件，再公开 prerelease；
不改变稳定 Latest。公开后三次连续匿名发现、资产 API 和浏览器下载校验失败时撤回 draft。

发布后将原始 CI 资产保存至 `output/release-0.6.0-beta.1/public/`，独立执行：

```sh
node scripts/release-assets.mjs v0.6.0-beta.1 --public output/release-0.6.0-beta.1/public
node scripts/live-legacy-update.mjs \
  output/release-0.5.0/public/confucius.xpi \
  output/release-0.6.0-beta.1/public/confucius.xpi \
  output/release-0.6.0-beta.1/legacy-stable.json
node scripts/live-legacy-update.mjs \
  output/release-0.5.1-beta.1/public/confucius.xpi \
  output/release-0.6.0-beta.1/public/confucius.xpi \
  output/release-0.6.0-beta.1/legacy-beta.json
```

旧包通过自身原始更新器调用真实 GitHub，不替换网络或版本响应；核对安装包摘要、
新版本、重启后的草稿与渠道选择、禁止降级和自动检查设置独立性。
本节只定义流程，实际结果在完成后追加，不用候选测试结果代替。

候选原始证据位于忽略目录 `output/release-0.6.0-beta.1/`，包括自动检查日志、
产物摘要、批注与子任务报告、上下文专项、两份升级报告和热更新报告。

## 发布后公开包验收结果

发布提交为 `0a53efb852f89d5f08967515d31aac3f12cbc4f1`。
[tag CI](https://github.com/ZionDoki/confucius/actions/runs/37437169272) 的 Node.js 22、
24 验证和发布任务全部通过；对应
[master CI](https://github.com/ZionDoki/confucius/actions/runs/37437169303) 也通过。
[Release](https://github.com/ZionDoki/confucius/releases/tag/v0.6.0-beta.1)
于 `2026-10-06T08:38:08Z` 公开，ID `404488748`，`draft=false`、`prerelease=true`，
Latest 仍为 `v0.5.0`。标题、tag、正文与 CHANGELOG 提取结果已核对。

| 原始 CI 公开产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `confucius.xpi` | 733937 | `c7dac01bc526ad637ab583082423f0e759dd9cb678fcbf5f6446725fb3e3b3c7` |
| `update-beta.json` | 587 | `4fde652ed0f5ea0a68e837ed4af96636a85b767e333b6176bc1280ea0e283320` |

CI 和本地独立验收均通过连续三次匿名发现、资产 API 下载、浏览器下载与摘要核对。
公开 XPI 的 19 个文件解包后逐字节匹配本地已测候选；ZIP 元数据导致包摘要不同，
公开包的原始字节始终保持不变，未用本地重建包替换。

`scripts/live-legacy-update.mjs` 正常安装两个原始旧 XPI，通过旧包自身的更新器
调用真实 GitHub，两个场景均首次通过，无重试、替换响应或临时版本修改：

| 真实在线升级 | 检查数 | 结果 |
| --- | ---: | --- |
| `0.5.0 → 0.6.0-beta.1` | 12 | 通过 |
| `0.5.1-beta.1 → 0.6.0-beta.1` | 12 | 通过 |

Beta 开关关闭时不提供测试版，开启后发现并安装本次公开包。安装返回
`restartRequired=false`，随后完整退出重启仍为目标版本，已安装文件摘要匹配公开 XPI。
任务和中文草稿、显式渠道选择均保留；已安装版本不会重复提供；关闭 Beta 不降级；
再次重启保留关闭状态和独立的自动检查偏好。

原始公开资产、CI 元数据、匿名核对日志、解包比较和两份在线升级报告保存在同一
忽略目录中。本节为发布后追加记录，未移动 tag 或修改公开安装包。
