# 0.5.0-beta.4 发布验收

2026-09-22 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `9f88680` 改善子 Agent 的等待反馈、并发调度和公开过程查看，发布源码由
`v0.5.0-beta.4` 固定。本地候选与公开 CI 安装包分别验收，不混用二进制摘要。

## 发布前检查

- `npm run release:check -- v0.5.0-beta.4`、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、
  `npm run versions:check` 与 `npm run sync-skills:check` 均通过。
- 1,130 项测试通过，零失败、零跳过：根脚本 8、harness 169、mcp-client 5、
  memory 66、protocol 121、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 703。
- 根包、全部 workspace、锁文件、协议常量、XPI manifest 和 Beta 更新记录均为
  `0.5.0-beta.4`；插件 ID 为 `confucius@zotero.plugin`，更新链接指向本次 tag。
- 从干净目录构建，只产生 `update-beta.json`，没有混入稳定 `update.json`；更新
  SHA-512 与 XPI 一致。manifest 和更新记录的 Zotero 范围均为 `6.999–10.*`，
  本轮仅实测 10.0.3。
- 本地候选 XPI：702,423 bytes，SHA-256：
  `73ff6fd02f493abee648b0ee5d474066b99649a8d98286ac845b864a3a26e5b7`。

## 子 Agent 交互与调度

`scripts/live-subagents.mjs` 使用正常安装候选 XPI 的独立 profile 和确定性模型数据，
17 组检查通过：

- 四个研究子任务中三个运行、一个排队；主任务显示等待完成数，独立卡片显示最近
  活动和工具调用数。一个完成后第四个开始；停止、重试和主任务最终结束正常。
- 卡片左右边界与聊天内容列完全一致；鼠标悬停、按下、释放不会移动控件。
- 共用同一个固定居中的气泡；点击入口和「上一个／下一个」只更换当前面板。
  切换、长短内容、读取中、排队状态以及主时间线滚动不改变浮层位置和大小。
- 每个子任务分别保留筛选、展开项、原始事件、已读取归档和滚动位置；只有当前面板
  挂载。人为延迟旧请求后快速切换，旧响应不会覆盖当前标题、状态或 trace。
- 40 次工具调用、123 条公开事件和 15 份归档完整加载；实时追加继续显示，保持
  展开项与内外滚动位置。筛选、输入／结果展示、完整归档尾部和诊断导出通过。
- 同一入口收起、Escape 返回入口焦点，外部点击不抢焦点；切换主任务关闭气泡。
  主任务诊断导出含四个子任务及完整归档，私有模型上下文未进入报告。
- 中文浅色 1,120px、深色 420px／280px、英文 420px，以及 420×460px 小窗口中，
  浮层居中并保留至少 8px 边距，内部无横向溢出，头尾操作可见，按钮高度保持 34px。
  UI 错误为空；截图与上一轮同布局实机检查一致。

自动化回归另覆盖初始化工具／保存失败后释放并发名额、结束父任务等待，取消等待，
重试后忽略旧执行回调，外部工具输入／成功或失败结果配对，以及重试后复用调用 ID
时独立分组。真实模型响应很慢与调度故障是不同情况，本次不宣称所有等待都已消除。

## 文献与升级回归

- `scripts/live-literature.mjs` 的 17 组检查通过：胶囊计数与单一列表、对齐和开合状态、
  筛选及候选、窄窗、实际 PDF 导入、拒绝无效 PDF、目标浏览器／拖入操作、子 Agent
  浮层、确认后继续及完整退出重启。匿名 OpenAlex 检索返回 100 条真实文献。
- 从公开 Beta 3 升级候选包，26 项检查通过。旧包 XPI 为 697,177 bytes，SHA-256：
  `bb3ad83df898f647981d7cb23b0b7215d6e82e91d7a7cdf334acd82c0c45af28`，
  下载后与 GitHub 资产元数据核对一致。
- 升级前由旧包创建真实 Zotero 论文、PDF、批注、笔记、报告修订、多窗口历史、
  中文草稿、记忆、待审提案、文献池和候选，并完成一个子任务。
- 升级和完整重启保留子任务身份、结果及每条公开事件；新版诊断可导出旧子任务。
  文献池内容、查询、候选、任务来源与预算保留，历史／工作笔记正文逐文件摘要一致。
  显式继续不重复写入已完成笔记，升级本身不触发模型执行；再次重启仍保持数据。
- `scripts/live-update-window.mjs` 七组检查通过：窗口和侧栏安装后恢复当前任务、
  中文草稿、更新设置页及侧栏折叠状态；连续热更新可用；预先关闭的工作区保持关闭。
  实际安装立即生效；暂存等待重启文案通过受控状态验证，持久化另用完整重启验证。

## 复现与限制

```sh
CONFUCIUS_SUBAGENT_OUTPUT=output/release-0.5.0-beta.4/candidate-subagents node scripts/live-subagents.mjs
CONFUCIUS_LITERATURE_OUTPUT=output/release-0.5.0-beta.4/candidate-literature node scripts/live-literature.mjs
CONFUCIUS_UPDATE_OUTPUT=output/release-0.5.0-beta.4/candidate-hot-update node scripts/live-update-window.mjs output/release-0.5.0-beta.4/old-beta/confucius.xpi
node output/release-0.5.0-beta.4/upgrade.mjs
```

`CONFUCIUS_SUBAGENT_XPI` 和 `CONFUCIUS_LITERATURE_XPI` 可指定其他待验收包。
原始报告、日志、截图、摘要与升级驱动放在已忽略的 `output/release-0.5.0-beta.4/`；
隔离配置在 `.scaffold/`。未操作日常 profile、个人文库或用户模型凭据。

模型输出及大部分检索使用本地确定性数据；联网实测为匿名 OpenAlex 检索。
未实测付费模型、外部 Codex／Kimi 端到端执行、带密钥缓存全文、机构登录、Windows、
Linux、其他 Zotero 版本、大型个人文库或 forced-colors。更新器自动化回归覆盖
Beta 转同基础稳定版、渠道比较、自动检查及网络／HTTP／资产／摘要失败；未做
真实公网故障注入。公开 CI 安装包的下载校验及升级须在发布后另行记录。
