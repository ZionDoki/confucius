# Confucius 的 Zotero 链接导航

日期：2026-09-02
状态：已评审（用户批准方案 A）
范围：`packages/protocol`、`packages/zotero-tools`、`apps/zotero-addon`

## 问题与范围

当前 `renderMarkdownHtml`（`packages/protocol/src/markdown.ts`）的 `isSafeHref`
只放行 `http(s)/mailto/#`，`zotero://` 链接会被降级为纯文本。Zotero 使用
以下链接格式（见 `ZoteroProtocolHandler.mjs`）：

- `zotero://select/library/items/<key>`（群组：`zotero://select/groups/<gid>/items/<key>`）
- `zotero://open-pdf/library/items/<attachmentKey>?page=N&annotation=<annKey>`

Markdown 渲染器需要识别这些链接。点击后，已打开的阅读器获得焦点；未打开的
PDF 在阅读器中打开。聊天时间线、知识库和记忆面板使用同一套行为。

## §1 模块划分

| 模块          | 位置                                                             | 职责                                   |
| ------------- | ---------------------------------------------------------------- | -------------------------------------- |
| 渲染层        | `packages/protocol/src/markdown.ts`                              | `isSafeHref` 放行 `zotero:` scheme     |
| 链接解析/构造 | `packages/protocol/src/zoteroUri.ts`（新）                       | 纯函数，无 Zotero 依赖，解析与构造同源 |
| 导航器        | `apps/zotero-addon/src/modules/ui/linkNavigator.ts`（新）        | 聚焦已开标签/窗口或新开                |
| 模型侧        | `ZoteroToolHost` + `packages/zotero-tools` 工具描述 + 系统提示词 | 输出携带 `zoteroUri`，引导模型引用     |

## §2 zoteroUri 解析与构造

`parseZoteroUri(href)` 返回判别联合或 `null`：

```ts
type ZoteroUri =
  | { kind: "select"; libraryID?: number; groupID?: number; key: string }
  | {
      kind: "open-pdf";
      libraryID?: number;
      groupID?: number;
      attachmentKey: string;
      annotationKey?: string;
      page?: number;
    };
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

「已开则聚焦」使用 `Reader.navigate(location)`（`reader.js:755`）和
`Zotero.Reader._readers`。

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
- 知识库条目详情、记忆面板内容改用 `fillAnswerHtml` 渲染，链接可以点击。
  编辑状态仍使用 textarea。

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

## §8 测试

- 单测：`zoteroUri.ts` 解析/构造往返与非法输入；`markdown.ts` 放行
  `zotero://`、仍拦截 `javascript:` 等 scheme；导航器聚焦逻辑用
  fake `_readers` 单测。

## §9 内联审批

- 待审批项不再放右侧面板，而是作为卡片渲染在时间线（消息栏）底部，
  紧跟最后一条消息；Allow/Always/Deny 行为不变。
- 用户确认后 `approval_resolved` 事件驱动重渲染，卡片自然消失；
  新审批到达时时间线自动滚动到卡片可见。
- `reviewPane` 整体移除：面板、宽度拖拽（`reviewGrip`、
  `rememberedReviewWidth`）、顶栏切换按钮（`reviewToggle`）、侧栏抽屉分支、
  `showReview` 状态与自动弹出逻辑全部删除。
- 记忆管理（列表 + forget）迁移到「研究记忆」知识库窗口：主题栏底部新增
  「长期记忆」区，内容经 markdown 渲染，链接可点（复用 §4/§5 渲染层）。
- 本地化清理：删除 `workspace-toggle-review`、`workspace-review`、
  `workspace-empty-review`、`workspace-review-grip`；记忆相关文案保留给记忆页面。
- 测试同步：`workspace-document.test.mjs` 中两个断言旧面板的用例改写为
  断言时间线卡片与移除后的状态。

## 假设

- `zotero://` 链接只在插件自有界面消费；Zotero 原生笔记编辑器本来就支持
  该协议，不在本次范围。
- 「新开」沿用 `Zotero.Reader.open` 默认行为（主窗口新标签；用户可用
  Zotero 自身设置改为新窗口），聚焦逻辑为自定义。
