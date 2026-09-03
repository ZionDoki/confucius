# Confucius 阅读器闭环与上下文脊柱 · 设计

日期：2026-09-02
状态：已评审（用户逐节批准）
范围：Zotero 插件（`apps/zotero-addon`），不含 Chrome 扩展形态

## 背景与目标

当前产品形态是「放在 Zotero 旁边的聊天面板」：入口只有工具栏按钮/Tools 菜单；
系统提示仅注入主列表首选条目；阅读器打开的 PDF、当前页、选区要靠模型主动调
`get_pdf_selection`、靠用户用文字描述；写回（高亮/批注）commit 后用户要自己去找。

目标：把产品形态变成「住在阅读循环里的 agent」，服务三个场景——
单篇深读闭环、书库级整理、知识产出。手段是方案 A：先建上下文脊柱，再按
深读 → 整理 → 产出 顺序垂直切片交付，每切片独立可用。

核心判断：三个场景共享同一组缺口（上下文不可见、入口太深、写回开环），
脊柱先修好，后续切片边际成本最小。

## §1 上下文脊柱（活上下文 chip）

### 数据模型

host 侧新增 live context 快照，三类 chip：

| kind                   | 来源                                                           | 内容                                                  |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `reader`               | `Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)`             | PDF 标题、attachment/parent key、当前页 label         |
| `selection`            | reader `_selectionRanges`（复用 `get_pdf_selection` 取值路径） | 选文前 60 字、页、position                            |
| `items` / `collection` | `ZoteroPane.getSelectedItems()` / 选中集合或 saved search      | 条目数（prompt 注入最多 10 条 summarizeItem）或集合名 |

- 新 RPC `context/live` 返回快照；view 随现有 2s poll 拉取，不新增推送通道。
- 更新时机依赖 poll 天然覆盖（reader 切 tab、选区变化、主列表选择变化均在下个 poll 反映）。
  若实测延迟不可接受，再注册 `Zotero.Reader.registerEventListener("selectionChanged")` 触发即时刷新。
- chip 不持久化、不进会话记录。

### UI

- composer 上方一行 chip 栏；无 chip 时隐藏不占位。
- chip 样式沿用暖雾 pill（`#f0ece3` 系、radius 8px、0.93em）。
- 点击 reader/selection chip → 跳阅读器对应页（走 §2 的 `open_item` 位置参数）。
- selection chip 的 `×` = 本轮起暂停注入选区，直到出现新选区；view 在
  `session/prompt` 参数里带 `context: { suppressSelection: true }`，host 侧生效。

### 注入

`AgentHost.buildSystemPrompt` 增加 `Live context:` 段，替换现有
「Current Zotero selection: …」单行（被 items chip 超集覆盖）：

- reader：标题、libraryID/key、页 label
- selection：选文截断 2000 字符（除非 suppressSelection）
- items：最多 10 条 `summarizeItem`；否则 collection 名

### 不做

上下文管理面板、手动附加任意文件、chip 持久化。

## §2 切片一：深读闭环

### 阅读器入口

- 不向 PDF 阅读器工具栏注入额外按钮；工作区统一由 Zotero 右上角的
  Confucius 全局按钮打开，避免同一功能出现两个视觉入口。
- 新模块 `src/modules/ui/readerContextMenu.ts`：通过 Reader 公开事件注册
  选区右键模板（解释选区、核验论断、保存洞见、生成笔记）。菜单点击时捕获
  完整上下文快照，打开工作区，并按所选模板直接创建和启动任务。
- 启动注册挂到 `hooks.ts`；选区 chip 继续承担可见上下文与定位能力。

### 写回定位

- `ZoteroToolHost.open_item` 扩展可选参数 `pageIndex` / `annotationKey`，
  走 `Zotero.Reader.open(itemId, { pageIndex, annotationKey })`。
  实施时以 `tmp/zotero-source` 的 Reader API 为准，若选项不支持则降级为
  open 后调用 reader 实例导航方法。
- 时间线工具行与审批卡：结果含 `attachmentKey` +（`pageIndex`/`position`/`annotationKey`）
  时渲染「⌖ 定位」链接，点击调 `open_item` 位置参数。
  覆盖工具：`propose_highlights`、`commit_annotations`、`get_annotations`、`get_pdf_selection`。
- commit 审批通过且对应阅读器正打开时，自动定位到第一条新高亮（一次性、不弹提示）。

### 不做

阅读器内嵌评论面板、prompt 自动预填。

## §3 切片二/三：整理入口 + 知识产出

### 切片二 · 书库整理

- 新模块 `src/modules/ui/itemMenu.ts`：主窗口加载后往 `#zotero-itemmenu` 追加两项：
  - 「Confucius · 深读此文」：单选且 `findPdf` 有结果时显示 → 打开工作区 + 预选技能 `paper-deep-reading`
  - 「Confucius · 整理所选」：多选（≥2）显示 → 打开工作区 + 预选 `library-triage`；
    所选条目由脊柱 items chip 自动注入
- 技能预选传递：AgentHost 存 `pendingLaunch { skillSlug }`，新 RPC
  `workspace/launch-consume` 返回并清空；view poll 时应用 `applySkill`。
- 集合场景不加菜单，靠 collection chip 自动注入。

### 切片三 · 知识产出

- 新写工具 `propose_note`：参数 `{ title, markdown, parentRef? }`，
  复用现有 propose→approval→commit 管线；commit 创建 Zotero note 条目
  （父条目 = parentRef 或 reader chip 条目或首选条目，均无则独立 note）。
  markdown → note HTML 用 host 侧最小转换（标题/列表/粗体/代码块），不引外部依赖。
- 入口：review 栏头部「写入笔记」按钮 → 新 RPC `note/propose-from-session { sessionId }`，
  host 把会话各轮 answer 拼成 markdown 草稿，默认标题
  `Confucius · {会话标题} · {YYYY-MM-DD}` → 进审批卡。
- 标题编辑 UI 不做。知识库 overlay 不动。

## §4 测试与验收

### 单测（沿用字符串检查式约束）

- `test/workspace-document.test.mjs`：chip 栏渲染、`Live context:` 段、
  定位链接、`propose_note` 审批复用、「写入笔记」按钮、item menu 与
  reader context menu 注册代码存在；
  保持「禁 native select」等既有断言。
- host 侧：selection 截断 2000、suppressSelection 生效、`open_item` 位置参数、
  `propose_note` commit 创建 note、`launch-consume` 一次性语义。

### 交付顺序

1. §1 脊柱 → 2. §2 深读闭环 → 3. §3 整理/产出。每切片独立
   `npm run typecheck` + 全仓 `npm test` 全绿后进入下一切片。

### Computer Use 验收（AGENTS.md 硬要求）

每切片完成后用 Computer Use 打开真实窗口走用户路径：
窄侧栏 + 宽悬浮窗两形态、右上角全局按钮、阅读器选区右键模板、
选区 chip 出现与注入、定位跳转、itemmenu 两项、写入笔记审批。桌面操控若被中断，
如实声明「未能用 Computer Use 打开界面」，不得假装看过。

## 关键文件

- `apps/zotero-addon/src/modules/host/AgentHost.ts` — context/live、注入段、pendingLaunch、note/propose-from-session
- `apps/zotero-addon/src/modules/tools/ZoteroToolHost.ts` — open_item 位置参数、propose_note
- `apps/zotero-addon/src/modules/ui/WorkspaceView.ts` — chip 栏、定位链接、写入笔记按钮、launch 消费
- `apps/zotero-addon/src/modules/ui/readerContextMenu.ts`（新）— 阅读器选区右键模板与点击时上下文捕获
- `apps/zotero-addon/src/modules/ui/itemMenu.ts`（新）— 条目树右键菜单
- `packages/protocol/src/rpc.ts` — 新 RPC 与类型

## 假设与风险

- Zotero 7 `Reader.open` 支持 `{ pageIndex, annotationKey }`；以 tmp/zotero-source 实测为准，有降级路径。
- `#zotero-itemmenu` DOM id 在 Zotero 7 稳定（社区插件通用做法）。
- 2s poll 对选区延迟可接受；不可接受时补 selectionChanged 事件。
