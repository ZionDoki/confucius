# 0.5.0-beta.6 发布验收

2026-09-23 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `926174e` 修复应用内更新失败。发布源码由 `v0.5.0-beta.6` 固定；
本地候选与公开 CI 安装包分别记录，不覆盖 Beta 5 的 tag 或安装包。

## 问题与修复

Beta 5 的安装包可以下载，但 GitHub 的匿名 Release 列表给该版返回空 `assets`，
与独立的 Release 资产接口不一致。恢复附件文件名仅修正了下载入口，未修复旧更新器
只读取列表的问题。Beta 6 在最新、符合用户渠道的 Release 缺少 XPI 时，查询该
Release ID 的资产接口，然后执行原有地址、大小和 SHA-256 校验。

- 只查询最高可升级版本，不以更旧版本或未经校验的浏览器下载地址替代错误包。
  Release ID 必须为正安全整数，请求地址由固定仓库和 ID 生成，不信任 `assets_url`。
- 列表和补查共享一次检查的总超时；超时、真实缺包、非法资产及网络失败仍可见、可重试，
  迟到响应不恢复已失效的检查结果。稳定渠道不查询 Beta 资产。
- CI 先创建草稿并上传完整文件，按资产接口验证名称、uploaded 状态、大小和 SHA-256，
  再公开 Release；发布后检查与旧客户端相同的匿名列表，并实际下载 XPI 校验。
- 发布前阻止修改已公开 Release，上传时禁止覆盖文件。附件保留真实文件名。

## 发布前检查

- 1,155 项自动化测试通过，零失败、零跳过：根脚本 13、harness 169、mcp-client 5、
  memory 66、protocol 121、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 723。
- 类型检查、lint、构建、版本一致性及技能同步检查通过。发布说明通过
  `npm run release:check -- v0.5.0-beta.6` 校验。
- 根包、workspace、锁文件、协议常量、XPI 和更新记录同为 `0.5.0-beta.6`；
  插件 ID 为 `confucius@zotero.plugin`，兼容范围 `6.999–10.*`，下载链接指向本次 tag，
  SHA-512 与包一致，产物只有 XPI 和 `update-beta.json`。
- 本地候选 XPI 为 707,346 bytes，SHA-256：
  `322129d57eedd9517c424f7e5a0b50da8bf621438ffb3fad30d7dd1656b9b765`。
- 本地更新 JSON 为 587 bytes，SHA-256：
  `96a18ddc66974f2fb4b2e33e61c9db641d0e3471661f598be9472bac98f3e47c`。

## 隔离 Zotero 实机验证

使用独立 profile、空文库和合成数据，正常安装 XPI；未操作日常文库和模型凭据。

- `scripts/live-update-discovery.mjs`：3 组通过。运行候选中的真实更新器，仅将它的
  当前版本临时设为 Beta 4，以发现公开 Beta 5；匿名 Release 列表确实缺少该版资产，
  更新器实际请求独立资产接口并取得正确包大小和 SHA-256。再次人为清空列表内资产，
  补查真实接口仍成功；关闭 Beta 后不提供该版本，也不请求 Beta 资产。未将该探针
  记作旧版更新器已能升级，它验证的是新代码在真实服务上的恢复能力。
- 从公开 Beta 5 升级本地候选：26 项通过。旧包真实创建论文、PDF、批注、笔记、
  报告修订、历史、中文草稿、记忆、待审提案、文献候选与子任务。正常升级及两次完整
  重启保留数据、来源和预算；40 份历史与工作笔记正文逐文件摘要一致。明确继续中断
  任务后没有重复写笔记，也没有重新分配预算。
- `scripts/live-update-window.mjs`：7 组通过。实际热安装保留窗口或侧栏中的任务、
  中文草稿、布局和更新设置；新版本立即生效，重复更新正常。原本关闭的工作区保持
  关闭；待重启状态的不同文案通过受控状态验证。

## 复现与限制

```sh
CONFUCIUS_DISCOVERY_OUTPUT=output/release-0.5.0-beta.6/discovery node scripts/live-update-discovery.mjs
CONFUCIUS_UPDATE_OUTPUT=output/release-0.5.0-beta.6/hot-update node scripts/live-update-window.mjs output/release-0.5.0-beta.5/public/confucius.xpi
node output/release-0.5.0-beta.6/upgrade.mjs
```

原始日志、包摘要和升级驱动在被忽略的 `output/release-0.5.0-beta.6/`。
原始 Beta 5 异常的发现探针需要在 Beta 6 公开前运行；之后可将
`CONFUCIUS_DISCOVERY_TARGET` 设为最新 Beta，以验证真实服务及清空列表资产的恢复路径。
模型输出使用本地确定性服务，未调用付费模型。Windows、Linux、其他 Zotero 版本、
外部 Codex／Kimi 端到端和带凭据全文获取未重验。本轮未改变研究交互组件。

## 公开发布与安装验收

`v0.5.0-beta.6` 指向 `71d1d44544bff1b22b8fbba4093ffdb5f7c80ee9`。
[源码主干 CI](https://github.com/ZionDoki/confucius/actions/runs/35841595401) 成功。
[tag CI](https://github.com/ZionDoki/confucius/actions/runs/35841595570) 的 Node.js
22／24 验证、草稿上传及资产校验成功，随后公开 Release；最后的旧客户端匿名列表
检查失败，所以 **tag CI 整体失败，不记作全部通过**。

- [公开 Release](https://github.com/ZionDoki/confucius/releases/tag/v0.5.0-beta.6)
  发布于 2026-09-23 09:15:12 UTC，保持 prerelease；Latest 仍为 `v0.4.6`，
  稳定版资产及 Beta 5 的 tag、安装包未替换。
- 公开 XPI 为 708,242 bytes，SHA-256：
  `ffa8d61b20079551d1be1d64c64023fafc099975f83d4d1d333a148034285866`。
- 公开更新 JSON 为 587 bytes，SHA-256：
  `9354e358501ad1bcf179fe6cfba8f5368b526aa8e90b200e6ebe22914716d5f0`。
- 匿名浏览器下载两份文件成功；大小、GitHub SHA-256、manifest 插件 ID／版本、
  兼容范围、更新链接及 SHA-512 一致。文件名直接可见。Release 正文从 CHANGELOG
  生成，发布后补充实测结果和一次手动安装说明。
- 从公开 Beta 4、Beta 5 和稳定版 0.4.6 **直接安装公开 XPI**，分别 26／26／20 项
  通过。完整重启保留任务、来源、预算、中文草稿、论文、批注、报告、记忆和待审提案；
  Beta 的文献池与子任务也保留。40／40／28 份历史及工作笔记正文逐文件一致，继续
  执行没有重复写笔记或新分配预算。
- 公开 Beta 6 的发现探针 3 项通过，访问真实匿名列表和独立资产接口；关闭 Beta
  后不请求该版资产。人为清空列表资产的情形也通过。
- 公开 Beta 6 的完整更新探针 4 项通过：仅将已安装新版更新服务中的当前版本暂设为
  Beta 5，真实发现 Beta 6、从资产 API 下载、校验并正常安装；完整重启后包摘要与
  公开 XPI 相同，中文草稿保留，当前版本不再重复提供，关闭 Beta 不降级且跨重启保留。
  这是对已修复更新器的实测，**不是旧版更新器自动升级成功的证据**。

### 初次发布时旧版在线升级失败

GitHub 的公开列表和按 tag 查询仍给 Beta 6 返回空 `assets`，按 Release ID／独立
资产接口则返回完整的两个 uploaded 文件。草稿先上传未消除这项服务端不一致；CI
新增的最后检查捕获并报告了它，没有放宽验收或重复上传已发布文件来使结果变绿。

从 Beta 4、Beta 5 和 0.4.6 实际旧版更新器开启 Beta，三条路径均在发现安装包时失败，
没有记为成功升级。旧代码无法通过这次失败的发现过程下载自身修复。此前提供的
手动安装建议只绕过了发现故障，没有满足旧版直接在线升级的要求，因此撤回“手动
安装一次即可视为修复”的结论。该发布端兼容性问题仍未解决。

原始证据包括 `public-package.json`（包校验通过、旧列表检查失败分别记录）、
`public-discovery/report.json`、`fixed-updater-install.json`、
`public-direct-upgrade-{beta4,beta5,stable}.json`、失败的
`public-upgrade-{beta4,beta5,stable}.json` 和 `tag-ci-failed.log`，均在忽略的 `output/`
目录。公开安装包、Git tag 和源码提交没有因补充验收文档而改变。

2026-09-23 后续复验：调整 Release 元数据、草稿状态与附件名称后，列表仍存在空
附件响应。一次读到完整列表不能证明恢复；未修改的 Beta 4、Beta 5、0.4.6 复验仍
失败。原始 `legacy-fixed-upgrade-{beta4,beta5,stable}.json` 和
`legacy-endpoint-probe.json` 保留失败证据。Beta 5／6 的 tag、XPI、更新 JSON 及其
资产 ID 和摘要未替换。新版本 Beta 7 同样在公开列表门禁和原版 Beta 5 实测中失败，
继续升版没有解决此问题。

## 后续在线升级成功，但稳定性未通过

发布信息随后恢复完整响应，使用原始公开旧包、自身未修改的更新器和真实 GitHub
接口，已经完成以下在线升级到公开 Beta 6 的检查：

- Beta 4、Beta 5、0.4.6：33／33／27 项通过，包含发现、下载、校验、安装、完整
  重启、渠道保存及禁止降级。任务、论文、预算、草稿、报告、记忆和待审提案保留；
  Beta 文献池与子任务 trace 保留，40／40／28 份历史正文摘要一致。
- Beta 1、Beta 3、0.4.3、0.4.4、0.4.5：各 11 项通过，真实在线升级、重启后包
  摘要及版本、任务草稿、渠道和禁止降级均通过。
- Beta 2 后续检查成功发现公开包，但下载发生网络错误；不计作安装成功。
- 三次连续匿名列表检查以及资产 API／浏览器两条下载路径曾同时通过。

继续在同一个未修改的 Beta 5 实例中每隔 10 秒检查，8 次结果为：成功、成功、缺包、
成功、缺包、缺包、成功、成功。故障并非只影响某个旧版本，也不能用一次成功升级或
连续三次成功响应推断已经稳定恢复。**旧版在线升级已实际跑通，服务稳定性仍未修复。**
不能继续要求用户先手动安装更新器，也不能宣称所有旧版已可靠直升。

成功证据为 `restored-public-upgrade-{beta4,beta5,stable}.json`、
`restored-legacy-0.4.{3,4,5}.json`、`restored-legacy-beta{1,3}-recheck.json`；
失败与间歇性证据为 `restored-legacy-beta2-recheck.json` 和
`legacy-stability-probe.json`，均保存在忽略的 `output/release-0.5.0-beta.6/`。
GitHub 支持报告已备好，未经用户授权未提交；没有联系外部人员。
