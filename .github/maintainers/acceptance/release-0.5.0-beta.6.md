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

公开 Release、匿名列表、公共下载及从旧版实际更新器升级的结果在发布后补充；
本地候选验证不代表这些步骤已经完成。
