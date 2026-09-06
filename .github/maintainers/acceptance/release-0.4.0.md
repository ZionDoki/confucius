# 0.4.0 发布验收

2026-09-06，Windows 11 专业版 build 26200，Zotero 10.0.1。
前两节随 `v0.4.0` 源码发布，记录打 tag 前已经完成的检查；末节为发布后追加结果。

## 本地正式版候选

- 版本：全部 workspace、lockfile、协议版本、XPI manifest 均为 `0.4.0`。
- XPI：510,518 bytes，SHA-256
  `67b549fcf1d0b6799757e59fd322f48c87a16202c077bd14ab9751b848877139`。
- 插件 ID：`confucius@zotero.plugin`，普通安装，兼容范围与更新文件一致。
- `update.json`、`update-beta.json` 均指向 `v0.4.0/confucius.xpi`，SHA-512
  与本地 XPI 一致。已核对 bootstrap、主脚本及正式正则 Worker。
- 719 项测试通过；typecheck、lint、build、技能同步、版本及 release 检查通过。

CI 会独立重建包，构建时间戳可能改变文件大小和摘要，发布后需以 GitHub 资产
摘要核对实际下载包。上面的本地摘要不能用作 CI 资产摘要。

## 0.3.8 → 0.4.0 升级

执行 `scripts/live-upgrade.mjs`，使用公开的 0.3.8 XPI 与上述正式版候选，在新建
隔离 profile 和 data 中安装。测试使用确定性本地模型服务，没有调用个人模型或
改动用户主库。

| 场景                   | 结果                                                           |
| ---------------------- | -------------------------------------------------------------- |
| 旧版任务与原生写入     | 创建真实笔记 `T5QYPYYT`，保留跨窗口历史、两版工作笔记及成果 r2 |
| 普通 AddonManager 升级 | 实际版本变为 0.4.0；17 个旧运行数据文件、源备份和身份保留      |
| 第一次重启             | 任务恢复为 interrupted，升级与重启期间模型派发为零             |
| 显式继续               | 复用已完成写入结果，原笔记只有一条；已用迭代从 2 累计到 4      |
| 第二次重启及导出       | 完成状态、原笔记和成果版本不变，已存历史与诊断记录可读         |

原始结果与本轮检查日志保存在本机 `output/release-0.4.0/`，未提交到仓库。

## 实测范围与发布后检查

三引擎真实文献、长上下文、Windows 文件占用、WPS 本地目录和迁移故障测试见
[前序实测记录](windows-acceptance-2026-09-06.md)。记录中的 Native 语义召回失败及
未执行项继续适用于本次发布判断，没有因转为正式版而改记为通过。

发布后按[发布规范](../releases.md)验证 GitHub Latest、资产摘要、Beta → 正式版
比较、插件自己的下载校验安装、重启和渠道选择保留。发布前的本地升级验收不能
代替公开资产的下载安装闭环；其结果另存本机发布验收报告。

## 发布后实测

2026-09-06 08:13 UTC 发布 `v0.4.0`，对应提交
`c8253cd6f5a89b9ca2b3ef8e5e6c1212f5816828`。
[标签 CI](https://github.com/ZionDoki/confucius/actions/runs/34021160511) 的
Node 22、24 验证和发布任务全部成功。GitHub 返回 `draft: false`、
`prerelease: false`，Latest 指向 `v0.4.0`。

- 公开 XPI：510,518 bytes，SHA-256
  `47e9d93faeaf44ffea34ca9c67f05cfc1bf3b139d8ed7d74f5fcdb5d6bab2ef6`。
  实际下载文件、GitHub 资产摘要和隔离 profile 内安装包的摘要一致。
- 两个更新 JSON 的版本、URL、兼容范围和 XPI SHA-512 正确；全部资产的
  SHA-256、大小和 uploaded 状态正确。Release 正文与 CHANGELOG 提取结果一致。
- 基线为前序 Windows 验收中包含新更新器的未发布 beta.1 候选，**不是公开的
  beta.1 包**。在 Zotero 全局自动更新关闭时，插件自己的手动检查和约 30 秒后的
  自动检查均发现 0.4.0；Beta 开关开启和关闭均能发现该稳定版。
- 通过实际 `update/install` 完成公开包下载、校验和普通安装，返回 ready；
  重启后的版本为 0.4.0，`temporarilyInstalled: false`。
- Native、Kimi、Codex 的三个任务 ID、窗口 ID、模型与工具次数、token 总数、
  三份成果的 ID／revision／正文摘要及六条批注的 key／正文／坐标／评论不变。
  没有新增笔记或批注，也没有发送新的模型任务。
- 通过 Zotero 正常退出再启动，关闭及开启的 Beta 选择分别保留；在 0.4.0 上
  两种渠道均报告已是最新版本。自动检查开关仍独立。

**新增已知问题：** Native 已完成任务的 `elapsedMs` 在插件卸载时从 15,058
变为 1,984,899，计入了完成后的空闲时间。耗时统计的全字段相等断言未通过；
上面其他持久化字段逐项通过。没有将这个差异删除后宣称全部预算数据相等，也没有
修改已发布的 XPI 来掩盖结果。

测试脚本首次正常退出调用使用了不存在的 `Zotero.setTimeout`；改用主窗口定时器
调用 Zotero 正常退出后完成验证。另一次“改偏好后立即强杀进程”发生偏好尚未写盘，
该场景不能算正常退出重启。原始失败记录与后续范围明确的结果均保留。

原始记录：`output/release-0.4.0/public-update-initial.json`、`public-update.json`
及 `published-assets.json`。最终更新流程状态为 `pass-with-known-limit`，保留
耗时问题；更早的 Native 语义召回失败和 WPS 云端未验证范围仍见前序实测记录。
