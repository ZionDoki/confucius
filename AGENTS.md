# AGENTS.md

本文件对在本仓库工作的人工智能代理具有约束力。动手前先读完。

改完代码后跑 `npm test` 和 `npm run typecheck`。

本地预览 Zotero 工作区：`npm start`（`apps/zotero-addon`，需要本机 Zotero 7+），点 Confucius 工具栏按钮打开工作区；偏好在 Zotero → Settings → Confucius。

## 版本、更新与发布

涉及版本号、更新功能、CHANGELOG、Git tag 或 GitHub Release 时，先读 [发布规范](.github/maintainers/releases.md)，按其中的准备、检查、发布和验收步骤执行。

- 公开版本使用 `MAJOR.MINOR.PATCH`；测试版使用 `MAJOR.MINOR.PATCH-beta.N`，`N` 从 1 开始递增。Git tag 必须是 `v<完整版本号>`。Beta 必须标记为 prerelease，不能设为 Latest。
- 根 `package.json` 是产品版本的来源。所有 workspace、`package-lock.json` 内根包和 workspace 版本、`packages/protocol/src/version.ts` 的 `CONFUCIUS_VERSION` 必须一致；构建后的 XPI manifest 和更新文件也必须对应同一版本。不要手改构建产物来凑版本号。
- 已发布的 tag、版本号和安装包不可复用或覆盖。修复已发布版本时递增版号；本地未发布改动先写入 `CHANGELOG.md` 的 `Unreleased`，不要把新改动补写成旧版本已发布的能力。
- 发布说明的唯一正文来源是 `CHANGELOG.md`。发版时使用唯一的 `## <版本号> - YYYY-MM-DD` 条目，写明用户可感知的变化、升级／迁移注意事项、实际验证结果和已知限制；不得以提交列表、占位符或未执行的验证代替。
- 更新由 Confucius 自行检查、比较、下载和校验。设置必须保留“接收测试版更新”开关，保存显式选择；关闭时只接收稳定版，开启时比较稳定版与 Beta，始终只升级到更高版本，关闭开关不能自动降级。自动检查开关与版本渠道开关独立。
- 发布前执行 `npm run release:check -- v<版本号>`、`npm test`、`npm run typecheck`、`npm run lint` 和 `npm run build`，并按发布规范核对产物和升级场景。代码／文档准备、打 tag、发布 Release、安装后的实测是不同状态，交付时如实说明完成到哪一步。

## 设计规范

改动任何 UI 前必须先读并遵循 [界面设计准则](docs/design.md)，以 APP（工作区顶栏／
时间线／输入区）为准。配色使用公共变量，顶栏复用公共按钮样式，常规与紧凑布局的
边距、尺寸均按准则执行；artifact 阅读界面不使用装饰性分割线。修改公共视觉规则时
同步更新该文档，禁止为阅读页另起一套配色与按钮尺寸。完工后对照自查清单核对，
再跑 `npm test` 和 `npm run typecheck`，如实说明实机验证范围。

## 文档范围

- `docs/` 面向产品用户，保留使用方法、设置、故障处理和已知限制，以及统一的界面设计准则 `docs/design.md`；入口为 `docs/README.md`。不放实现草稿、代理工作计划、临时测试日志或逐次开发记录。
- 仍需维护的架构、发布流程和验收记录放在 `.github/maintainers/`；原始 trace、机器路径、测试库和临时输出放在已忽略的 `output/`，不要提交凭据或个人文库内容。
- 删除过时设计文档时同步修复当前文档的链接。历史 Release 固定到旧 tag 的证据链接保留，不把新测试结果改写为旧版本的能力。
