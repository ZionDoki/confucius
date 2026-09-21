# 0.5.0-beta.1 发布验收

2026-09-21 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `4f4cf9c` 整理 OpenAlex 与科研助手改进；公开稳定版 0.4.6 的 tag 和包不变。
本记录区分本地候选与发布后的 CI 产物，构建摘要不要求相同。

## 发布前检查

- `npm run release:check -- v0.5.0-beta.1`、`npm run sync-skills:check`、`npm test`、
  `npm run typecheck`、`npm run lint`、`npm run build` 全部通过。
- 1,111 项测试通过，零失败、零跳过：根脚本 8、harness 164、mcp-client 5、memory 66、
  protocol 117、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 693。
- 根包、全部 workspace、锁文件、协议常量、XPI manifest 和 Beta 更新记录均为
  `0.5.0-beta.1`。插件 ID 为 `confucius@zotero.plugin`，更新链接指向对应 tag。
- 构建只生成 `update-beta.json`，没有将 Beta 写入稳定 `update.json`；更新 SHA-512
  与实际 XPI 一致。manifest 与更新记录的 Zotero 范围均为 `6.999–10.*`，本轮实机
  仅覆盖 Zotero 10.0.3。
- 本地候选 XPI：690,724 bytes，SHA-256：
  `37030d18522956fd08fef3b50379466f83408be52475b01ae8244a72d80a4c80`。

## 候选安装、文献与升级

使用独立 profile 与合成文库，安装普通 XPI；未修改日常 Zotero 配置或使用个人文库。

- `scripts/live-literature.mjs` 的 14 组记录通过：prompt 触发检索、100 条池与候选分离、
  卡片离屏胶囊、浮层位置／勾选／摘要／列表滚动保持、键盘操作、任务切换、批量确认、
  真实 PDF 入库、HTML／假 PDF 拒绝、浏览器派发与定向拖入、同请求继续委派、子任务
  气泡与完成结果、英文深色窄窗、退出重启恢复。
- 发布复测修正浮层打开期间主时间线仍可能跟随收尾消息滚动的问题；文献浮层展开时
  暂停主时间线自动跟随。页面未记录未捕获错误，窄窗无横向溢出且列表可滚至末尾。
- 真实匿名 OpenAlex 查询取得 100 条；不代表认证缓存 PDF 或真实额度扣费已验证。
- 公开 0.4.6 → 候选 0.5.0-beta.1 的 20 项检查通过。旧包 654,275 bytes，SHA-256
  `d1bb28fe36e2dc5fb819518960070263887614f4dc558423d107bb632eca5b8b`，与 GitHub 资产一致。
- 旧版创建真实论文、PDF、批注、笔记、两版报告、多窗口历史、工作笔记、记忆与待审
  提案后中断并重启。升级、两次新版重启及继续执行均保留原内容，原始历史正文逐文件
  摘要不变；升级不发起模型，继续不会重复写入已完成的笔记。
- 升级保留原有来源及分组。0.5.0 明确移除草稿来源后，当前文章关联按新来源更新；
  测试据此验证移除持久化与草稿内容保留，不沿用旧版“移除附件仍固定原分组”的断言。

- 旧 0.4.6 → 候选的热更新 7 项通过：已打开的窗口／侧栏自动重建，当前任务、即时
  中文草稿、更新设置页与侧栏折叠状态保留；重复安装同一候选可恢复，原先关闭的工作区
  不会被打开，禁用再启用不误恢复旧窗口。本机实际安装立即生效，无需重启；暂存等待
  重启文案用受控状态覆盖。

复现文献流程：`CONFUCIUS_LITERATURE_OUTPUT=output/release-0.5.0-beta.1/candidate-literature node scripts/live-literature.mjs`。
可用 `CONFUCIUS_LITERATURE_XPI` 指定待验收包。完整领域覆盖见
[文献研究验收](literature-research-2026-09-21.md)。原始输出、候选升级夹具和隔离配置
保留在已忽略的 `output/release-0.5.0-beta.1/` 与 `.scaffold/`。

## 未验证范围

没有可用的授权 OpenAlex Key 或在线模型凭据。本轮 Native 使用确定性本地模型，
Codex／Kimi 使用自动化适配器和生命周期回归；未进行真实在线三后端研究、认证缓存全文、
机构登录或真实额度扣费测试。未复测 Windows、Linux、其他 Zotero 版本、大型个人文库
或 forced-colors 实机表现。候选成功不等于公开 CI 包验收成功，公开发布后另行记录。

## 公开发布与安装后验收

`v0.5.0-beta.1` 指向提交 `4b799bc206f3933e804624c6d356b299c0ad9b78`，于
2026-09-21 07:08:39 UTC [公开发布](https://github.com/ZionDoki/confucius/releases/tag/v0.5.0-beta.1)。
`draft=false`、`prerelease=true`；Latest 保持 `v0.4.6`，原稳定版 tag 和资产未改动。

- [tag CI](https://github.com/ZionDoki/confucius/actions/runs/35571357146) 的 Node.js
  22／24 检查及发布任务全部成功；[主干 CI](https://github.com/ZionDoki/confucius/actions/runs/35571357025)
  也成功。发布正文与 CHANGELOG 提取结果逐字一致。
- 发布资产仅含 `confucius.xpi` 和 `update-beta.json`，均为 uploaded。下载大小、
  GitHub SHA-256、manifest 版本／插件 ID、兼容范围、更新链接与 SHA-512 全部核对。
- 公开 XPI：691,474 bytes，SHA-256：
  `06cc9eaf4348567de14f3ca9bdbca0c2bce0ee584e6909511fed4ff79f1ca543`。
- 公开更新 JSON：587 bytes，SHA-256：
  `a90768ec0083cfe74758ec9f3688d0cb5ee11bc5bded07ed5bd6692ac6c08a8d`。

公开 XPI 在新的隔离 Zotero 10.0.3 配置中重新完成文献流程 **14 组通过**，包括对话卡片、
胶囊、候选确认、真实文件操作、子任务气泡、窄窗、重启及一次匿名 OpenAlex 查询。
另外从公开 0.4.6 通过真实 Confucius 更新器完成公开 Beta 升级，**27 项通过**：

- 稳定渠道不提供 Beta；显式开启后发现 0.5.0-beta.1，并完成下载、校验、安装与重启。
- 旧任务、中文草稿、来源、批注、笔记、报告修订、原始历史、工作笔记、记忆、待审提案
  和预算保留；原始正文逐文件摘要一致，继续任务不重复写笔记。
- 实际安装文件摘要与公开 XPI 一致；当前版本不重复提供更新；关闭 Beta 不降级，
  重启保留显式稳定渠道选择。

原始结果为 `public-package.json`、`public-literature/result.json` 与
`public-upgrade-stable.json`，均位于已忽略的本次 `output/` 目录。验收进程已退出，
未安装到日常 profile。此补充仅记录发布后事实，不改动 tag、代码或公开安装包；
模型凭据与平台范围仍受上面的未验证范围约束。
