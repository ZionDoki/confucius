# 0.5.0-beta.2 发布验收

2026-09-21 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `dcd0c2b` 完成 models.dev 参考目录、输入筛选列表和 Native 自定义思考设置。
本次发布源码由 `v0.5.0-beta.2` 固定；本记录区分本地候选与公开 CI 安装包。

## 发布前检查

- `npm run release:check -- v0.5.0-beta.2`、`npm run sync-skills:check`、`npm test`、
  `npm run typecheck`、`npm run lint`、`npm run build` 均通过；版本一致性检查通过。
- 1,120 项自动化测试通过，零失败、零跳过：根脚本 8、harness 169、mcp-client 5、
  memory 66、protocol 121、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 693。
- 根包、全部 workspace、锁文件、协议常量、XPI manifest 与 Beta 更新记录均为
  `0.5.0-beta.2`。插件 ID 为 `confucius@zotero.plugin`，更新链接指向对应 tag。
- 从干净构建目录生成 `update-beta.json`，未混入稳定 `update.json`；更新 SHA-512
  与 XPI 一致。manifest 与更新记录的 Zotero 范围均为 `6.999–10.*`；本轮实机
  仅验证 Zotero 10.0.3。
- 本地候选 XPI：697,528 bytes，SHA-256：
  `b76f8edc92ee41ede9d493307aaa23a5a5c8745cf6f2a926c4d950ebbbe62468`。

## 模型设置实机验收

使用独立 profile、空文库和正常安装的 XPI；没有改动日常 Zotero 配置或个人文库。
`scripts/live-model-settings.mjs` 九组检查通过：

- 从 models.dev 下载真实公开目录；60 条结果显示为带样式的列表，最大高度受限，
  在设置对话框内滚动，无原生 `select` 菜单。
- 方向键保留输入框焦点，只滚动结果；Escape 先收起列表，点击输入框可重新展开。
- 输入自动过滤整个缓存目录；键盘选择、应用参考配置保留网关地址、密钥和模型别名。
- 编辑筛选条件清除旧选择；延迟回复不会覆盖新查询；输入法组字不提前查询或选择。
- 查询失败可重试；鼠标选择、无结果和清空筛选行为正确。
- 思考格式按钮支持键盘操作；保存的 `ultra` 经真实请求适配器以
  `reasoning_effort` 发往本地合成服务。
- 中文浅色与英文深色窄窗截图人工核对；列表不横向溢出。退出并重启 Zotero 后，
  自定义思考格式、档位和当前选择保留。

API 数据解析、24 小时缓存、失败后重试、模型精确匹配、端点隔离、配置持久化以及
不同思考参数格式另有自动化覆盖。生产代码没有按 `mirror.lzu.edu.cn` 主机名分支；
本次将测试中的示例主机改为保留的测试域名，历史验收记录保持原貌。

## Beta 1 升级与热更新

旧包为公开 0.5.0-beta.1，691,474 bytes，SHA-256：
`06cc9eaf4348567de14f3ca9bdbca0c2bce0ee584e6909511fed4ff79f1ca543`，
下载后与 GitHub 资产元数据核对一致。

- Beta 1 → 本地候选 20 项检查通过：旧版创建真实论文、PDF、批注、笔记、两版报告、
  多窗口历史、工作笔记、记忆和待审提案，随后中断、重启、升级及再次重启。
- 请求、中文草稿、来源、上下文身份、预算、笔记、报告修订与待审提案保留；
  所有原始历史正文逐文件摘要一致，证据引用仍可读取。
- 升级不会自行发起模型请求；继续任务不重复写已完成的笔记；再次重启保留完成态、
  草稿来源修改、组织方式及原有内容。显式渠道和关闭自动更新的选择保留。
- `scripts/live-update-window.mjs` 七组检查通过：窗口与侧栏热更新自动恢复所选任务、
  即时中文草稿、更新设置页和折叠状态；连续热更新可用；原先关闭的工作区保持关闭；
  禁用再启用不误恢复旧窗口。
- 本机实际安装立即生效，无需重启；“暂存待重启”文案通过受控状态验证。
  完整退出重启另行验证持久化，未将临时开发插件加载视为安装成功。

复现：`CONFUCIUS_MODEL_SETTINGS_OUTPUT=output/release-0.5.0-beta.2/candidate-settings npm run test:live:model-settings`。
可用 `CONFUCIUS_MODEL_SETTINGS_XPI` 指定其他 XPI。原始日志、截图、升级脚本与结果保留
在已忽略的 `output/release-0.5.0-beta.2/`；隔离配置保留在 `.scaffold/`。

## 未验证范围

目录请求访问真实 models.dev；模型推理、延迟回复和失败场景使用合成数据与本地服务，
没有调用付费在线模型。目录只是参考，不保证不同网关的 ID、容量与思考参数一致；
本版不导入思考 token 预算。未实测 Windows、Linux、其他 Zotero 版本、大型个人文库
或 forced-colors。以上为本地候选验收；公开 CI 包的安装与升级结果见下文，未验证
范围同样适用。

## 公开发布与资产验收

`v0.5.0-beta.2` 指向提交 `e243aaeca5b3aade78b0c91b8ee45a4241fa72de`，于
2026-09-21 10:35:05 UTC [公开发布](https://github.com/ZionDoki/confucius/releases/tag/v0.5.0-beta.2)。
`draft=false`、`prerelease=true`；Latest 保持 `v0.4.6`，其资产 ID、大小和摘要保持不变。

- [tag CI](https://github.com/ZionDoki/confucius/actions/runs/35589307961) 的 Node.js
  22／24 检查和发布任务全部成功；[主干 CI](https://github.com/ZionDoki/confucius/actions/runs/35589307259)
  同样成功。发布正文与 CHANGELOG 提取结果一致。
- 公开资产仅含 `confucius.xpi` 和 `update-beta.json`，均为 uploaded。下载大小、
  GitHub SHA-256、manifest 版本／插件 ID、Zotero 兼容范围、更新链接与 SHA-512
  全部核对一致。
- 公开 XPI：698,530 bytes，SHA-256：
  `a518ef0d05f200750b718857e0029e9e18091f1a4f969d152aa0ba9ab3cc187f`。
- 公开更新 JSON：587 bytes，SHA-256：
  `0aaf97485ea81cc4431ff22265d0bc8595ebace511f1382d3969398d266f4737`。

公开 XPI 在新的隔离 Zotero 10.0.3 配置中重新完成全部九组模型设置检查，包括真实
公开目录、输入法、延迟回复、失败重试、思考参数发送、深色窄窗和完整退出重启。

分别从公开 **0.5.0-beta.1** 与 **0.4.6** 经真实 Confucius 更新器升级到公开 Beta 2，
每条路径 **27 项检查通过**：

- Zotero 全局更新关闭时，Confucius 手动检查正常。稳定渠道不提供 Beta；显式开启
  测试渠道后发现 0.5.0-beta.2，完成公开资产下载、摘要校验、安装和重启。
- 所有候选升级检查再次通过：任务、中文草稿、来源、批注、笔记、报告修订、原始
  历史、工作笔记、记忆、待审提案与预算保留；原始正文逐文件摘要一致，继续执行
  不重复写入已完成的笔记。
- 实际安装文件与公开 XPI 摘要一致；当前版本不重复提供更新；关闭 Beta 不降级，
  重启后显式稳定渠道选择保留。

Beta 转同基础稳定版的顺序、独立自动检查定时器、网络／HTTP 失败、超时、资产缺失
与校验失败由本轮 `UpdateService.test.ts` 自动化回归覆盖；这些失败场景未另做真实
公网故障注入。热更新布局恢复使用候选包完成上述七组实机检查。

原始结果为 `public-package.json`、`public-settings/result.json`、
`public-upgrade-beta.json` 与 `public-upgrade-stable.json`，位于本次已忽略的 `output/`
目录。隔离验收进程均已退出，未安装到日常 profile。此补充只记录发布后事实，
不改动 tag、发布正文或公开安装包。
