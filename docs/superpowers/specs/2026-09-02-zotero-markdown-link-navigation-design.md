# Confucius Markdown 链接导航封装 · 设计

日期：2026-09-02
状态：已评审（用户批准方案 A）
范围：`packages/protocol`、`packages/zotero-tools`、`apps/zotero-addon`

## 背景与目标

当前 `renderMarkdownHtml`（`packages/protocol/src/markdown.ts`）的 `isSafeHref`
只放行 `http(s)/mailto/#`，任何 `zotero://` 链接都会被降级为纯文本。
而 Zotero 本身有成熟的链接标准（见 `ZoteroProtocolHandler.mjs`）：

- `zotero://select/library/items/<key>`（群组：`zotero://select/groups/<gid>/items/<key>`）
- `zotero://open-pdf/library/items/<attachmentKey>?page=N&annotation=<annKey>`

目标：做一层统一的 markdown 渲染封装，凡符合标准的链接，点击后跳转到对应
内容——已打开的阅读器标签页/窗口聚焦过去，未打开的新开；覆盖聊天时间线、
知识库、记忆面板所有展示面；模型回答自动携带这类链接。

## §1 模块划分

| 模块 | 位置 | 职责 |
|---|---|---|
| 渲染层 | `packages/protocol/src/markdown.ts` | `isSafeHref` 放行 `zotero:` scheme |
| 链接解析/构造 | `packages/protocol/src/zoteroUri.ts`（新） | 纯函数，无 Zotero 依赖，解析与构造同源 |
| 导航器 | `apps/zotero-addon/src/modules/ui/linkNavigator.ts`（新） | 聚焦已开标签/窗口或新开 |
| 模型侧 | `ZoteroToolHost` + `packages/zotero-tools` 工具描述 + 系统提示词 | 输出携带 `zoteroUri`，引导模型引用 |

## §2 zoteroUri 解析与构造

`parseZoteroUri(href)` 返回判别联合或 `null`：

```ts
type ZoteroUri =
  | { kind: "select"; libraryID?: number; groupID?: number; key: string }
  | { kind: "open-pdf"; libraryID?: number; groupID?: number; attachmentKey: string;
      annotationKey?: string; page?: number };
```

- `library` 前缀不携带 libraryID（导航时取用户库），`groups/<gid>` 携带
  groupID（`Zotero.Groups.getLibraryIDFromGroupID` 换算）。
- `buildZoteroUri(...)` 与之互逆，工具输出用它构造，保证构造/解析同源。
- 兼容 ZotFile 旧格式（`zotero://open-pdf/<libraryID>_<key>/<page>`）解析，
  构造只用标准格式。

## §3 导航行为

导航器输入解析结果，规则：

```
select:
  聚焦主窗口 → 按 libraryID+key 取条目 → pane.selectItem(id)
open-pdf:
  解析附件条目（libraryID + attachmentKey）
  ├─ Zotero.Reader._readers 中 itemID 相同者
  │   ├─ 有 tabID：主窗口 Zotero_Tabs.select(tabID) → reader.navigate(location)
  │   └─ 独立窗口：聚焦其 _window → reader.navigate(location)
  └─ 未找到：Zotero.Reader.open(id, { location })
location = annotationKey ? { annotationID } : page ? { pageIndex: page - 1 } : null
```

「已开则聚焦」依赖 `Reader.navigate(location)`（`reader.js:755`）与
`Zotero.Reader._readers` 枚举，均已在 Zotero 源码中核实。

## §4 渲染层改动

- `isSafeHref`：白名单追加 `zotero:`，其余逻辑不动。
- 渲染产物仍是普通 `<a href>`，不加自定义属性。

## §5 UI 接线

- `WorkspaceView` 保持平台无关：`WorkspaceHost` 接口新增
  `openLink(href: string): void`。
- 工作区 root 一次性事件委托：拦截 `<a>` 点击，`preventDefault` 后转交
  `host.openLink`（同时覆盖主窗口侧栏与独立工作区窗口两种布局）。
- 插件侧实现 `openLink`：
  - `zotero://` → 导航器；
  - `http/https/mailto` → `Zotero.launchURL`（系统浏览器）；
  - 其他 → 忽略。
- 知识库条目详情、记忆面板内容由纯文本改为经 `fillAnswerHtml` 渲染，
  链接自然可点（编辑态仍是 textarea，不动）。

## §6 模型侧链接生成

- `summarizeItem` 追加 `zoteroUri` 字段（`zotero://select/...`）。
- `get_annotations` 每条标注附 `zoteroUri`（`zotero://open-pdf/library/items/
  <attachmentKey>?annotation=<key>`）。
- 工具描述（`packages/zotero-tools/src/catalog.ts`）与系统提示词追加引导：
  引用文献/标注时使用 `[标题](<zoteroUri>)` 的 markdown 链接。

## §7 错误处理

- URI 解析失败或条目不存在：工作区状态栏显示本地化错误（新增
  `workspace-link-not-found` 文案），不静默。
- `open-pdf` 附件无文件：降级为 `select` 选中父条目并提示。
- 群组条目换算失败按不存在处理。

## §8 测试与验收

- 单测：`zoteroUri.ts` 解析/构造往返与非法输入；`markdown.ts` 放行
  `zotero://`、仍拦截 `javascript:` 等 scheme；导航器聚焦逻辑用
  fake `_readers` 单测。
- Computer Use 验收（AGENTS.md 硬性要求）：真实工作区内让模型回复含
  文献/标注链接，验证：聚焦已开标签、新开、标注定位、外部链接系统浏览器、
  知识库/记忆面板渲染可点。

## 假设

- `zotero://` 链接只在插件自有界面消费；Zotero 原生笔记编辑器本来就支持
  该协议，不在本次范围。
- 「新开」沿用 `Zotero.Reader.open` 默认行为（主窗口新标签；用户可用
  Zotero 自身设置改为新窗口），聚焦逻辑为自定义。
