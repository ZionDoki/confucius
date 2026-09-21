# 0.5.0-beta.3 发布验收

2026-09-21 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `3b28212` 将每个任务的检索结果集中到单一文献胶囊，并将胶囊和回到最新
按钮放入与输入框对齐的独立布局行。发布源码由 `v0.5.0-beta.3` 固定。
以下为本地候选验收，公开 CI 包的摘要与安装、升级结果需另外核对。

## 发布前检查

- `npm run release:check -- v0.5.0-beta.3`、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、
  `npm run versions:check` 与 `npm run sync-skills:check` 均通过。
- 1,120 项测试通过，零失败、零跳过：根脚本 8、harness 169、mcp-client 5、
  memory 66、protocol 121、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 693。
- 根包、全部 workspace、锁文件、协议常量、XPI manifest 与 Beta 更新记录均为
  `0.5.0-beta.3`。插件 ID 为 `confucius@zotero.plugin`，更新链接指向本次 tag。
- 从干净构建目录生成 `update-beta.json`，没有稳定 `update.json`；SHA-512 与 XPI
  一致。manifest 与更新记录的 Zotero 范围均为 `6.999–10.*`，本轮仅实测 10.0.3。
- 本地候选 XPI：696,237 bytes，SHA-256：
  `63fcf38110eb774e2795574d2e662a2aaf2621b44baf7561b2032eaa23d875ad`。

## 文献交互与样式

`scripts/live-literature.mjs` 在正常安装候选 XPI 的隔离 profile 中完成 17 组检查：

- 空任务没有入口；开始检索后始终只有一个胶囊，重复检索归入同一去重结果池，
  时间线无重复文献卡片。`9 / 100` 的 100 来自实际文献池，不使用 API 总命中 2,500。
- 胶囊左边缘与输入框左边缘对齐；回到最新按钮右边缘与输入框右边缘对齐，两者
  同行居中、间距独立。真实鼠标悬停、按下、释放后的控件几何位置保持不变。
- 展开、收起、方向键切换标签、Escape、输入筛选、摘要、列表滚动和外部点击通过；
  浮层开合不滚动主对话，重新展开保留状态，外部点击不抢焦点。
- 零结果仍可进入胶囊调整查询；切换任务清除旧任务的列表、查询历史和确认状态。
  回到最新会关闭浮层并滚到对话末尾，同时保留文献入口。
- 中文浅色 1,100px、英文深色 420px 和 280px 窗口中，两种入口同时可见且不重叠；
  浮层在窗口内，内部列表可滚至末尾，没有窗口横向溢出，截图人工核对通过。
- 保留全文与委派流程：复用已有条目、实际 PDF 导入、HTML／伪造 PDF 拒绝、
  目标明确的浏览器与拖入操作、子 Agent 气泡、确认后同一请求继续和完整退出重启。
  UI 错误为空；真实匿名 OpenAlex 请求取回 100 条文献。

## Beta 2 升级与热更新

旧包来自公开 `v0.5.0-beta.2`，698,530 bytes，SHA-256：
`a518ef0d05f200750b718857e0029e9e18091f1a4f969d152aa0ba9ab3cc187f`。
下载后与 GitHub 资产元数据核对一致。

- Beta 2 → 本地候选 23 项检查通过。旧包创建实际 Zotero 论文、PDF、批注、笔记、
  两版报告、跨窗口历史、中文草稿、记忆、待审提案，以及两篇文献的结果池和一个候选。
- 中断、恢复、升级和再次重启后，任务身份、来源、预算、草稿、报告修订与笔记保留；
  旧历史和工作笔记正文逐文件摘要一致，证据引用仍可读取，继续不会重复写已完成笔记。
- 旧版文献内容、查询历史、候选决定和计数逐字段保持一致。恢复检查点会正常递增池
  的 revision；新增验收最初将此递增误判为内容变化，核对既有恢复逻辑后修正断言并
  重新完整通过。仅允许池 revision 递增，候选版本和实际内容仍严格比较。
- 显式更新渠道、关闭自动检查的选择和任务组织方式保持；升级没有自行发起模型请求。
- `scripts/live-update-window.mjs` 七组检查通过：窗口和侧栏安装后自动恢复所选任务、
  中文草稿、更新设置页及折叠状态；连续热更新可用；预先关闭的工作区保持关闭；
  禁用再启用不会误恢复旧窗口。
- 本机实际安装立即生效，无需重启。“暂存待重启”文案通过受控状态验证；完整退出
  重启另行验证持久化，没有将临时开发加载视为安装成功。

## 复现与限制

```sh
CONFUCIUS_LITERATURE_OUTPUT=output/release-0.5.0-beta.3/candidate-literature node scripts/live-literature.mjs
CONFUCIUS_UPDATE_OUTPUT=output/release-0.5.0-beta.3/candidate-hot-update node scripts/live-update-window.mjs output/release-0.5.0-beta.3/old-beta/confucius.xpi
node output/release-0.5.0-beta.3/upgrade.mjs
```

`CONFUCIUS_LITERATURE_XPI` 可以指定其他待验收包。原始结果、截图、包摘要和本次升级
驱动脚本保留在已忽略的 `output/release-0.5.0-beta.3/`，隔离配置保留在 `.scaffold/`。
所有验收仅操作独立 profile 和合成数据，没有修改日常 Zotero 配置或个人文库。

模型输出、错误和大部分搜索结果为本地确定性数据；真实联网部分是匿名 OpenAlex
检索。未调用付费模型，未实测带密钥缓存全文、机构登录、Windows、Linux、其他
Zotero 版本、大型个人文库或 forced-colors。Beta 转同基础稳定版、独立自动检查、
网络／HTTP 失败、超时、资产缺失和摘要校验失败由本轮更新器自动化回归覆盖，未做
真实公网故障注入。公开安装包的验收应在发布后单独记录，不能套用本地二进制摘要。
