# Confucius Markdown 链接导航封装 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 markdown 渲染层识别标准 `zotero://` URI，点击跳转/聚焦到条目或标注，模型输出自动携带可点击链接。

**Architecture:** 渲染层放行 `zotero:` scheme（protocol 包）；纯函数解析/构造 `zoteroUri.ts`；插件侧 `linkNavigator` 负责聚焦已开阅读器或新开；`WorkspaceView` 事件委托把点击转交宿主 `openLink`；工具输出与系统提示词引导模型携带链接。

**Tech Stack:** TypeScript（npm workspaces、tsx、node:test）、Zotero 7 API（`Zotero.Reader`、`Zotero_Tabs`、`launchURL`）、Fluent 本地化。

**规格:** `docs/superpowers/specs/2026-09-02-zotero-markdown-link-navigation-design.md`（含 §9 审批内联化后补需求）

**注意:** 工作区有大量与本任务无关的未提交改动；每个 Task 的 commit 只 `git add` 本任务列出的文件，禁止 `git add -A`。Windows + pwsh，命令中路径用正斜杠。

---

### Task 1: protocol 包 — zoteroUri 解析与构造

**Files:**
- Create: `packages/protocol/src/zoteroUri.ts`
- Create: `packages/protocol/src/zoteroUri.test.ts`
- Modify: `packages/protocol/src/index.ts`（第 77 行 `export { escapeHtml, ... }` 附近追加导出）

- [ ] **Step 1: 写失败测试** `packages/protocol/src/zoteroUri.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenPdfUri, buildSelectUri, parseZoteroUri } from "./zoteroUri";

describe("parseZoteroUri", () => {
  it("parses select for user library", () => {
    assert.deepEqual(parseZoteroUri("zotero://select/library/items/ABC123"), {
      kind: "select",
      key: "ABC123",
    });
  });

  it("parses select for a group library", () => {
    assert.deepEqual(
      parseZoteroUri("zotero://select/groups/42/items/ABC123"),
      { kind: "select", groupID: 42, key: "ABC123" },
    );
  });

  it("parses open-pdf with annotation", () => {
    assert.deepEqual(
      parseZoteroUri(
        "zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY",
      ),
      { kind: "open-pdf", attachmentKey: "PDF9KEY", annotationKey: "ANN1KEY" },
    );
  });

  it("parses open-pdf with page", () => {
    assert.deepEqual(
      parseZoteroUri("zotero://open-pdf/library/items/PDF9KEY?page=12"),
      { kind: "open-pdf", attachmentKey: "PDF9KEY", page: 12 },
    );
  });

  it("parses legacy ZotFile form", () => {
    assert.deepEqual(
      parseZoteroUri("zotero://open-pdf/0_abcd1234/7"),
      { kind: "open-pdf", attachmentKey: "abcd1234", page: 7 },
    );
  });

  it("rejects malformed input", () => {
    assert.equal(parseZoteroUri(""), null);
    assert.equal(parseZoteroUri("https://example.com"), null);
    assert.equal(parseZoteroUri("zotero://select/library"), null);
    assert.equal(parseZoteroUri("zotero://select/groups/x/items/K"), null);
  });
});

describe("build/parse roundtrip", () => {
  it("roundtrips select", () => {
    const uri = buildSelectUri("ABC123", 42);
    assert.equal(uri, "zotero://select/groups/42/items/ABC123");
    assert.deepEqual(parseZoteroUri(uri), {
      kind: "select",
      groupID: 42,
      key: "ABC123",
    });
  });

  it("roundtrips open-pdf", () => {
    const uri = buildOpenPdfUri("PDF9KEY", { annotationKey: "ANN1KEY" });
    assert.equal(
      uri,
      "zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY",
    );
    assert.deepEqual(parseZoteroUri(uri), {
      kind: "open-pdf",
      attachmentKey: "PDF9KEY",
      annotationKey: "ANN1KEY",
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @confucius/protocol`
Expected: FAIL — `Cannot find module './zoteroUri'`

- [ ] **Step 3: 实现** `packages/protocol/src/zoteroUri.ts`

```ts
/** Parse/build standard zotero:// URIs. Pure; no Zotero dependency. */

export type ZoteroSelectUri = {
  kind: "select";
  libraryID?: number;
  groupID?: number;
  key: string;
};

export type ZoteroOpenPdfUri = {
  kind: "open-pdf";
  libraryID?: number;
  groupID?: number;
  attachmentKey: string;
  annotationKey?: string;
  page?: number;
};

export type ZoteroUri = ZoteroSelectUri | ZoteroOpenPdfUri;

const SCHEME = /^zotero:\/\/(select|open-pdf|open)\/(.+)$/i;

function parsePage(raw: string | null): number | undefined {
  const value = Number(raw ?? "");
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseZoteroUri(href: string): ZoteroUri | null {
  const match = String(href || "").trim().match(SCHEME);
  if (!match) {
    return null;
  }
  const isSelect = match[1].toLowerCase() === "select";
  const [path, query = ""] = match[2].split("?");
  const segments = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  const page = parsePage(params.get("page"));
  const annotationKey = params.get("annotation") || undefined;

  if (segments[0] === "library" && segments[1] === "items" && segments[2]) {
    const key = safeDecode(segments[2]);
    return isSelect
      ? { kind: "select", key }
      : { kind: "open-pdf", attachmentKey: key, annotationKey, page };
  }
  if (segments[0] === "groups" && segments[2] === "items" && segments[3]) {
    const groupID = Number(segments[1]);
    if (!Number.isInteger(groupID) || groupID <= 0) {
      return null;
    }
    const key = safeDecode(segments[3]);
    return isSelect
      ? { kind: "select", groupID, key }
      : {
          kind: "open-pdf",
          groupID,
          attachmentKey: key,
          annotationKey,
          page,
        };
  }
  if (!isSelect && segments.length === 2) {
    const zotfile = segments[0].match(/^(\d+)_([A-Za-z0-9]+)$/);
    if (zotfile) {
      const libraryID = Number(zotfile[1]);
      return {
        kind: "open-pdf",
        libraryID: libraryID > 0 ? libraryID : undefined,
        attachmentKey: zotfile[2],
        page,
      };
    }
  }
  return null;
}

export function buildSelectUri(key: string, groupID?: number): string {
  const scope = groupID ? `groups/${groupID}` : "library";
  return `zotero://select/${scope}/items/${encodeURIComponent(key)}`;
}

export function buildOpenPdfUri(
  attachmentKey: string,
  options: { groupID?: number; annotationKey?: string; page?: number } = {},
): string {
  const scope = options.groupID ? `groups/${options.groupID}` : "library";
  const params = new URLSearchParams();
  if (options.annotationKey) {
    params.set("annotation", options.annotationKey);
  } else if (options.page) {
    params.set("page", String(options.page));
  }
  const query = params.toString();
  const base = `zotero://open-pdf/${scope}/items/${encodeURIComponent(attachmentKey)}`;
  return query ? `${base}?${query}` : base;
}
```

- [ ] **Step 4: 在 index.ts 导出**（紧跟 `export { escapeHtml, renderMarkdownHtml } from "./markdown";` 之后）

```ts
export {
  buildOpenPdfUri,
  buildSelectUri,
  parseZoteroUri,
} from "./zoteroUri";
export type { ZoteroOpenPdfUri, ZoteroSelectUri, ZoteroUri } from "./zoteroUri";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @confucius/protocol`
Expected: PASS（含已有 markdown/timeline 等测试）

- [ ] **Step 6: 提交**

```bash
git add packages/protocol/src/zoteroUri.ts packages/protocol/src/zoteroUri.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): parse and build standard zotero:// URIs"
```

---

### Task 2: protocol 包 — markdown 渲染放行 zotero: scheme

**Files:**
- Modify: `packages/protocol/src/markdown.ts:10-12`（`isSafeHref`）
- Test: `packages/protocol/src/markdown.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `markdown.test.ts` 的 `renderMarkdownHtml` describe 块内）

```ts
  it("renders zotero links and blocks dangerous schemes", () => {
    const html = renderMarkdownHtml(
      "Read [paper](zotero://select/library/items/ABC123) and " +
        "[ann](zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY) " +
        "and [bad](javascript:alert(1)).",
    );
    assert.match(html, /href="zotero:\/\/select\/library\/items\/ABC123"/);
    assert.match(html, /href="zotero:\/\/open-pdf\/library\/items\/PDF9KEY\?annotation=ANN1KEY"/);
    assert.equal(/<a href="javascript:/.test(html), false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @confucius/protocol`
Expected: FAIL（zotero href 未输出为链接）

- [ ] **Step 3: 修改 `isSafeHref`**（`packages/protocol/src/markdown.ts`）

```ts
function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|zotero:|#)/i.test(href.trim());
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @confucius/protocol`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/markdown.ts packages/protocol/src/markdown.test.ts
git commit -m "feat(protocol): allow zotero scheme in rendered markdown links"
```

---

### Task 3: 插件 — linkNavigator（聚焦已开阅读器或新开）

**Files:**
- Create: `apps/zotero-addon/src/modules/ui/linkNavigator.ts`
- Create: `apps/zotero-addon/src/modules/ui/linkNavigator.test.ts`
- Modify: `apps/zotero-addon/package.json`（test script 追加新测试文件）

- [ ] **Step 1: 写失败测试** `linkNavigator.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectExistingReader } from "./linkNavigator";

describe("selectExistingReader", () => {
  it("finds the reader for an open attachment", () => {
    const readers = [
      { itemID: 10, tabID: "tab-a" },
      { itemID: 20, tabID: "tab-b" },
    ];
    assert.equal(selectExistingReader(readers, 20)?.tabID, "tab-b");
  });

  it("returns null when the attachment is not open", () => {
    assert.equal(selectExistingReader([{ itemID: 1 }], 99), null);
    assert.equal(selectExistingReader([], 1), null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

先把测试文件加进 `apps/zotero-addon/package.json` 的 test script（在 `src/modules/host/SkillToolProvider.test.ts` 后追加 `src/modules/ui/linkNavigator.test.ts`）：

```json
"test": "node --import tsx --test test/*.test.mjs src/modules/ui/workspaceToggle.test.ts src/modules/host/SkillToolProvider.test.ts src/modules/ui/linkNavigator.test.ts",
```

Run: `npm test -w @confucius/zotero-addon`
Expected: FAIL — `Cannot find module './linkNavigator'`

- [ ] **Step 3: 实现** `linkNavigator.ts`

```ts
import { parseZoteroUri, type ZoteroUri } from "@confucius/protocol";
import { getString } from "../../utils/locale";

export interface OpenLinkResult {
  ok: boolean;
  message?: string;
}

type ReaderLike = {
  itemID: number;
  tabID?: string;
  _window?: Window;
  navigate?: (location: Record<string, unknown>) => Promise<void> | void;
};

/** Pick an already-open reader for the attachment, if any. */
export function selectExistingReader(
  readers: ReaderLike[],
  itemID: number,
): ReaderLike | null {
  return readers.find((reader) => reader.itemID === itemID) ?? null;
}

function resolveLibraryID(uri: ZoteroUri): number | null {
  if (uri.groupID) {
    return Zotero.Groups.getLibraryIDFromGroupID(uri.groupID) || null;
  }
  return Zotero.Libraries.userLibraryID;
}

function selectItemInMainWindow(item: Zotero.Item): void {
  const win = Zotero.getMainWindow();
  win?.focus();
  Zotero.getActiveZoteroPane?.()?.selectItem?.(item.id);
}

async function focusSelect(
  uri: Extract<ZoteroUri, { kind: "select" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const item = libraryID
    ? Zotero.Items.getByLibraryAndKey(libraryID, uri.key)
    : null;
  if (!item) {
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  selectItemInMainWindow(item);
  return { ok: true };
}

async function focusOpenPdf(
  uri: Extract<ZoteroUri, { kind: "open-pdf" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const attachment = libraryID
    ? Zotero.Items.getByLibraryAndKey(libraryID, uri.attachmentKey)
    : null;
  if (!attachment?.isFileAttachment?.()) {
    const parent = attachment?.parentItemID
      ? Zotero.Items.get(attachment.parentItemID)
      : null;
    if (parent) {
      selectItemInMainWindow(parent);
      return { ok: false, message: getString("workspace-link-pdf-missing") };
    }
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  const location: Record<string, unknown> | null = uri.annotationKey
    ? { annotationID: uri.annotationKey }
    : uri.page
      ? { pageIndex: uri.page - 1 }
      : null;
  const readers =
    (Zotero.Reader as unknown as { _readers?: ReaderLike[] })._readers ?? [];
  const existing = selectExistingReader(readers, attachment.id);
  if (existing) {
    const win = Zotero.getMainWindow();
    if (existing.tabID && win) {
      win.focus();
      (
        win as unknown as { Zotero_Tabs?: { select: (id: string) => void } }
      ).Zotero_Tabs?.select(existing.tabID);
    } else {
      existing._window?.focus();
    }
    if (location) {
      await existing.navigate?.(location);
    }
    return { ok: true };
  }
  await Zotero.Reader.open(attachment.id, location ? { location } : {});
  return { ok: true };
}

export async function navigateZoteroUri(
  uri: ZoteroUri,
): Promise<OpenLinkResult> {
  try {
    return uri.kind === "select"
      ? await focusSelect(uri)
      : await focusOpenPdf(uri);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openLink(href: string): Promise<OpenLinkResult> {
  const target = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(target)) {
    Zotero.launchURL(target);
    return { ok: true };
  }
  const uri = parseZoteroUri(target);
  if (!uri) {
    return { ok: false, message: getString("workspace-link-invalid") };
  }
  return navigateZoteroUri(uri);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @confucius/zotero-addon`
Expected: PASS（`selectExistingReader` 两项通过；linkNavigator 导入不触发 Zotero 调用）

- [ ] **Step 5: 提交**

```bash
git add apps/zotero-addon/src/modules/ui/linkNavigator.ts apps/zotero-addon/src/modules/ui/linkNavigator.test.ts apps/zotero-addon/package.json
git commit -m "feat(addon): link navigator focuses open readers or opens new ones"
```

---

### Task 4: 本地化文案与样式

**Files:**
- Modify: `apps/zotero-addon/addon/locale/en-US/addon.ftl`
- Modify: `apps/zotero-addon/addon/locale/zh-CN/addon.ftl`
- Modify: `apps/zotero-addon/src/modules/ui/WorkspaceView.ts`（`TUI_CSS` 中追加链接样式）
- Modify: `apps/zotero-addon/addon/content/workspace.css`（KB markdown 预览样式）

- [ ] **Step 1: ftl 文案**

`en-US/addon.ftl` 中 `confucius-workspace-memory-from-log` 附近追加：

```ftl
confucius-workspace-link-not-found = Linked item was not found in this library.
confucius-workspace-link-invalid = This link cannot be opened.
confucius-workspace-link-pdf-missing = PDF file is missing; showing the item instead.
confucius-workspace-knowledge-preview = Preview
```

`zh-CN/addon.ftl` 对应位置追加：

```ftl
confucius-workspace-link-not-found = 未在当前文库中找到该条目。
confucius-workspace-link-invalid = 无法打开该链接。
confucius-workspace-link-pdf-missing = PDF 文件缺失，已改为选中对应条目。
confucius-workspace-knowledge-preview = 预览
```

- [ ] **Step 2: TUI 链接样式**

在 `WorkspaceView.ts` 的 `TUI_CSS` 模板字符串内（`ensureTuiStyles` 使用的那段，文件顶部 `const TUI_CSS = ...` 区域）追加：

```css
.confucius-workspace-root a {
  color: #8a5a2b;
  text-decoration: underline;
  text-decoration-color: #cbb890;
  text-underline-offset: 2px;
  cursor: pointer;
}
```

- [ ] **Step 3: KB 预览样式**

在 `addon/content/workspace.css` 末尾追加：

```css
.confucius-kb-md-preview {
  border: 1px solid #e7e3da;
  border-radius: 8px;
  background: #fbfaf7;
  padding: 10px 12px;
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
  font-size: 0.95em;
  line-height: 1.5;
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck -w @confucius/zotero-addon`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add apps/zotero-addon/addon/locale/en-US/addon.ftl apps/zotero-addon/addon/locale/zh-CN/addon.ftl apps/zotero-addon/src/modules/ui/WorkspaceView.ts apps/zotero-addon/addon/content/workspace.css
git commit -m "feat(addon): locale strings and styles for clickable markdown links"
```

---

### Task 5: WorkspaceView 点击委托、记忆与知识库 markdown 渲染

**Files:**
- Modify: `apps/zotero-addon/src/modules/ui/WorkspaceView.ts`

改动点 4 处，全部在现有结构上做最小修改：

- [ ] **Step 1: `WorkspaceHost` 增加可选 `openLink`**（约第 31 行）

```ts
export interface WorkspaceHost {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  openLink?(href: string): Promise<{ ok: boolean; message?: string }>;
}
```

- [ ] **Step 2: root 级一次性点击委托**

在模块顶部（`const HTML_NS` 附近）追加：

```ts
const linkHosts = new WeakMap<HTMLElement, WorkspaceHost | null>();
const linkListeners = new WeakSet<HTMLElement>();
```

在 `bindWorkspace` 中 `root.textContent = "";` 之后（约第 967 行后）插入：

```ts
  linkHosts.set(root, host);
  if (!linkListeners.has(root)) {
    linkListeners.add(root);
    root.addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href") || "";
      const boundHost = linkHosts.get(root);
      if (!href || href.startsWith("#") || !boundHost?.openLink) {
        return;
      }
      event.preventDefault();
      void boundHost.openLink(href).then((result) => {
        if (!result.ok && result.message) {
          status.style.color = "#b3452f";
          status.textContent = result.message;
        }
      });
    });
  }
```

注意：该段引用闭包变量 `status`（约第 1036 行创建的状态栏元素），因此插入位置必须**在 `const status = ...` 之后**。放到 `status` 定义完成后、其他布局代码继续之前的合适位置；若结构不便，把委托注册移到一个在 `status` 之后调用的小函数里。

- [ ] **Step 3: 记忆内容改 markdown 渲染**

注意：记忆卡片当前在 `reviewPane` 内（`body.textContent = durableExcerpt(memory.content);`），Task 10 会把整个卡片迁到知识库窗口。本步只需把该行的渲染方式改为：

```ts
      fillAnswerHtml(body, durableExcerpt(memory.content));
```

（Task 10 搬迁时保留此渲染方式。）

- [ ] **Step 4: 知识库条目编辑器加实时 markdown 预览**

在 `renderKnowledgeEditor` 中，`mindWorkspace` 构造块（`const mindWorkspace = el(doc, "div");` … `wrap.appendChild(mindWorkspace);`，约 2141–2170 行）之后追加：

```ts
    const mdPreview = el(doc, "div");
    mdPreview.className = "confucius-kb-md-preview";
    const previewCaption = el(doc, "div");
    previewCaption.className = "confucius-kb-section-label";
    previewCaption.textContent = getString("workspace-knowledge-preview");
    const paintMarkdownPreview = () => {
      const hidden = selectedKind === "mindmap" || !content.value.trim();
      previewCaption.style.display = hidden ? "none" : "";
      mdPreview.style.display = hidden ? "none" : "";
      if (!hidden) {
        fillAnswerHtml(mdPreview, content.value);
      }
    };
    content.addEventListener("input", paintMarkdownPreview);
    wrap.appendChild(previewCaption);
    wrap.appendChild(mdPreview);
```

并在同函数内已有的 `syncKind()` 定义末尾追加一行 `paintMarkdownPreview();`，同时在 `syncKind()` 初次调用之后再调一次 `paintMarkdownPreview();`（保证切换类型时预览刷新）。若 `paintMarkdownPreview` 定义在 `syncKind` 之后，将两者的声明顺序调整为预览函数先定义。

- [ ] **Step 5: 验证**

Run: `npm run typecheck -w @confucius/zotero-addon`
Run: `npm test -w @confucius/zotero-addon`
Expected: 全部通过（`workspace-document.test.mjs` 不受影响，因 `openLink` 为可选）

- [ ] **Step 6: 提交**

```bash
git add apps/zotero-addon/src/modules/ui/WorkspaceView.ts
git commit -m "feat(addon): delegate markdown link clicks and render memory/kb markdown"
```

---

### Task 6: Addon 实例暴露 openLink

**Files:**
- Modify: `apps/zotero-addon/src/addon.ts`

- [ ] **Step 1: 修改 `addon.ts`**

```ts
import { config } from "../package.json";
import hooks from "./hooks";
import { openLink as navigateLink } from "./modules/ui/linkNavigator";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {

  /** Workspace looks up `Zotero.Confucius.rpc`. */
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.hooks.host.rpc(method, params);
  }

  /** Workspace link clicks land here (`Zotero.Confucius.openLink`). */
  openLink(href: string): Promise<{ ok: boolean; message?: string }> {
    return navigateLink(href);
  }
}
```

`workspaceWindow.ts` 的 `getHost()` 只检查 `typeof candidate.rpc === "function"`，Addon 实例天然满足，无需改动。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck -w @confucius/zotero-addon`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add apps/zotero-addon/src/addon.ts
git commit -m "feat(addon): expose openLink on the plugin instance"
```

---

### Task 7: 模型侧 — 工具输出携带 zoteroUri 与提示词引导

**Files:**
- Modify: `apps/zotero-addon/src/modules/tools/ZoteroToolHost.ts`
- Modify: `packages/zotero-tools/src/catalog.ts`
- Modify: `apps/zotero-addon/src/modules/host/AgentHost.ts`（约 1334–1337 行 `buildSystemPrompt`）

- [ ] **Step 1: `ZoteroToolHost.ts` — 构造辅助函数**

文件顶部导入追加 `buildOpenPdfUri, buildSelectUri`（来自 `@confucius/protocol`），并在 `summarizeItem` 之前加：

```ts
function groupIDForLibrary(libraryID: number): number | undefined {
  if (libraryID === Zotero.Libraries.userLibraryID) {
    return undefined;
  }
  const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
  return groupID || undefined;
}
```

- [ ] **Step 2: `summarizeItem` 增加字段**（约第 53–61 行）

```ts
  return {
    libraryID: item.libraryID,
    key: item.key,
    itemType: item.itemType,
    title: item.getDisplayTitle?.() || item.getField?.("title") || "",
    creators: authors,
    year: item.getField?.("year") || "",
    doi: item.getField?.("DOI") || "",
    zoteroUri: buildSelectUri(item.key, groupIDForLibrary(item.libraryID)),
  };
```

- [ ] **Step 3: `getAnnotations` 每条标注附链接**（约第 1568–1596 行的 `.map((ann) => ({...}))`）

在 `sortIndex`、`position` 同层追加：

```ts
        zoteroUri: buildOpenPdfUri(pdf.key, {
          groupID: groupIDForLibrary(pdf.libraryID),
          annotationKey: ann.key,
        }),
```

- [ ] **Step 4: 工具描述**（`packages/zotero-tools/src/catalog.ts`）

`search_items` 描述改为：

```
"Search library items by title, creator, or everywhere. Each result carries a zoteroUri for clickable linking."
```

`get_annotations` 描述改为：

```
"List annotations as JSON. Each annotation carries a zoteroUri linking into the PDF."
```

- [ ] **Step 5: 系统提示词**（`AgentHost.ts` `buildSystemPrompt` 的 parts 数组）

把 `"Use tools to inspect the library. Cite items as libraryID:key.",` 替换为：

```ts
      "Use tools to inspect the library. Cite items as libraryID:key.",
      "Tool results carry zoteroUri fields; when mentioning a paper or an",
      "annotation, emit a Markdown link [title](zoteroUri) so the user can",
      "click to jump to it.",
```

- [ ] **Step 6: 验证**

Run: `npm run typecheck -w @confucius/zotero-addon`
Run: `npm test -w @confucius/zotero-tools`（确认 `catalog.test.ts` 仍通过；若断言了旧描述文本，同步更新断言）
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add apps/zotero-addon/src/modules/tools/ZoteroToolHost.ts packages/zotero-tools/src/catalog.ts apps/zotero-addon/src/modules/host/AgentHost.ts
git commit -m "feat: tool outputs and prompts emit clickable zoteroUri links"
```

（若 `catalog.test.ts` 有改动一并 `git add`。）

---

### Task 8: 全量回归

- [ ] **Step 1: 各包测试与 typecheck**

Run: `npm test -w @confucius/protocol`
Run: `npm test -w @confucius/zotero-tools`
Run: `npm test -w @confucius/zotero-addon`
Run: `npm run typecheck -w @confucius/zotero-addon`
Run: `npm run typecheck -w @confucius/protocol`
Expected: 全部 PASS

- [ ] **Step 2: lint**

Run: `npm run lint -w @confucius/zotero-addon`
Expected: 通过（如有格式问题用 `npm run lint:fix -w @confucius/zotero-addon` 修复后重跑）

---

### Task 9: Computer Use 真机验收（AGENTS.md 硬性要求）

前置：`npm start`（`apps/zotero-addon`）启动带插件的 Zotero，打开 Confucius 工作区。

- [ ] **Step 1: 聊天链接跳转**

在工作区输入一条会触发 `search_items`/`get_annotations` 的请求（如「列出某篇文献的标注」），确认模型回复中出现 `[标题](zotero://...)` 渲染为可点击链接。

- [ ] **Step 2: 聚焦与新开行为**

- 未打开该 PDF 时点击标注链接 → 新开阅读器并定位到标注位置。
- 已打开该 PDF（标签页）时再次点击 → 聚焦原标签页并滚动到标注，不新开。
- 点击 `zotero://select/...` 链接 → 主窗口聚焦并选中条目。

- [ ] **Step 3: 外部链接**

回复中普通 `https` 链接点击后用系统浏览器打开，不在 Zotero 内导航。

- [ ] **Step 4: 知识库与记忆面板**

- 知识库条目编辑器输入含链接的 markdown，预览区实时渲染且链接可点。
- 记忆面板中含链接的记忆条目渲染为可点击链接。

- [ ] **Step 5: 错误态**

构造失效链接（删除目标条目后点击历史消息中的链接）→ 状态栏显示「未在当前文库中找到该条目。」，不崩溃。

- [ ] **Step 5: 审批卡片（规格 §9）**

- 触发写操作（如 `propose_highlights` + `commit_annotations`）→ 待审批卡片出现在消息栏底部（而不是右侧面板）。
- 点 Allow/Always/Deny 后卡片立即消失，时间线继续。
- 界面中不再存在待确认栏：无右侧面板、无「待确认」切换按钮、无宽度拖拽条。
- 新审批到达时消息栏自动滚动，卡片可见。

- [ ] **Step 6: 记忆页面管理**

打开「研究记忆」窗口，主题栏底部「长期记忆」区：记忆列表可见、内容 markdown 渲染、链接可点、forget 删除生效。

- [ ] **Step 7: 回归**

切换会话、发送新消息、侧栏/窗口两种布局切换、窄窗口响应式，确认无回归。发现问题修复后重新 Computer Use 复验。

若 Computer Use 不可用，必须在回复中明确写「未能用 Computer Use 打开界面」并说明替代手段。

---

## 验收清单（对应规格）

| 规格章节 | 任务 |
|---|---|
| §2 zoteroUri 解析/构造 | Task 1 |
| §4 渲染层放行 | Task 2 |
| §3 导航行为 | Task 3 |
| §7 错误处理 | Task 3 + Task 4 + Task 5（状态栏） |
| §5 UI 接线 | Task 5 + Task 6 |
| §6 模型侧链接生成 | Task 7 |
| §8 测试与验收 | Task 8 + Task 9 |
| §9 审批内联化与面板移除 | Task 10（Task 9 Step 5/6 验收） |

---

### Task 10: 审批时间线卡片、移除待确认面板、记忆迁入记忆页面（规格 §9）

**Files:**
- Modify: `apps/zotero-addon/src/modules/ui/WorkspaceView.ts`
- Modify: `apps/zotero-addon/addon/locale/en-US/addon.ftl`、`zh-CN/addon.ftl`
- Modify: `apps/zotero-addon/addon/content/workspace.css`
- Modify: `apps/zotero-addon/test/workspace-document.test.mjs`

- [ ] **Step 1: 时间线审批卡片**

在 `renderLists` 的时间线渲染段（`renderWaiting` 追加之前）插入：

```ts
    for (const item of state.approvals) {
      timelinePane.appendChild(renderApprovalCard(doc, item));
    }
```

把原 `reviewPane` 里的审批卡片构造抽成函数（复用原有样式与三个按钮逻辑）：

```ts
  function renderApprovalCard(
    targetDoc: Document,
    item: ApprovalRow,
  ): HTMLElement {
    const card = el(targetDoc, "div", {
      border: "1px solid #b05c2e",
      borderRadius: "8px",
      padding: "8px 10px",
      marginBottom: "8px",
      background: "#f5f3ee",
    });
    const name = el(targetDoc, "div", {
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: "11px",
      fontWeight: "600",
      letterSpacing: "0.04em",
      color: "#b05c2e",
    });
    name.textContent = item.toolName;
    const pre = el(targetDoc, "pre", {
      whiteSpace: "pre-wrap",
      fontSize: "11px",
    });
    pre.textContent = JSON.stringify(item.args, null, 2);
    const actions = el(targetDoc, "div", {
      display: "flex",
      gap: "6px",
      marginTop: "6px",
    });
    const allow = button(targetDoc, "", "Allow", "primary");
    const always = button(targetDoc, "", "Always");
    const deny = button(targetDoc, "", "Deny");
    deny.style.background = "#ffffff";
    deny.style.border = "1px solid #b3452f";
    deny.style.color = "#b3452f";
    allow.addEventListener("click", () => {
      void resolveApproval(item.id, "allow", "once");
    });
    always.addEventListener("click", () => {
      void resolveApproval(item.id, "allow", "always");
    });
    deny.addEventListener("click", () => {
      void resolveApproval(item.id, "deny", "once");
    });
    actions.appendChild(allow);
    actions.appendChild(always);
    actions.appendChild(deny);
    card.appendChild(name);
    card.appendChild(pre);
    card.appendChild(actions);
    return card;
  }
```

新审批可见性：`collectApprovals` 中 0→N 的分支改为设置标志：

```ts
    let newApprovalsArrived = false;
    // 原 hadPendingApprovals 判断处：
    if (!hadPendingApprovals && state.approvals.length > 0) {
      newApprovalsArrived = true;
    }
```

（删除其中 `showReview = true`、`syncAuxiliaryPanes` 调用。）`renderLists` 时间线滚动处：

```ts
    timelinePane.scrollTop =
      followTimeline || newApprovalsArrived
        ? timelinePane.scrollHeight
        : savedTimelineScroll;
    newApprovalsArrived = false;
```

（`newApprovalsArrived` 声明在 `bindWorkspace` 闭包顶层。）

- [ ] **Step 2: 移除 reviewPane 及其全部连带**

删除：`DEFAULT_REVIEW_WIDTH`、`rememberedReviewWidth`、`reviewToggle` 创建与 `topbarActions.appendChild(reviewToggle)`、`showReview`、`reviewPane`、`reviewGrip`（含拖拽/双击复位监听）、`columns.appendChild(reviewGrip/reviewPane)`、`syncAuxiliaryPanes` 中所有 `reviewPane`/`reviewToggle`/`reviewGrip` 分支、`renderLists` 中原 `reviewPane` 审批与记忆渲染段、`reviewLabel` 变量及所有引用。
保留：`sessionsToggle`/`sessionPane` 及其抽屉逻辑不动。
检查 `layoutCleanups`、响应式宽度、持久化宽度相关引用一并清理（若无持久化偏好则无需改 `prefs.js`）。

- [ ] **Step 3: 记忆迁入「研究记忆」窗口**

在 `renderKnowledgeTopics()` 返回列表前（`pane.appendChild(list);` 之后）追加长期记忆区：

```ts
    pane.appendChild(sectionLabel(getString("workspace-memory")));
    if (state.logCount > 0) {
      pane.appendChild(
        muted(doc, `${state.logCount} ${getString("workspace-session-logs")}`),
      );
    }
    if (!state.memories.length) {
      pane.appendChild(muted(doc, getString("workspace-no-memory")));
    }
    for (const memory of state.memories) {
      const card = el(doc, "div", {
        border: "1px solid #e5e1d8",
        borderRadius: "8px",
        padding: "6px 8px",
        marginBottom: "6px",
        background: "#ffffff",
      });
      const title = el(doc, "div", {
        fontSize: "11px",
        color: "#33302a",
        fontWeight: "700",
      });
      const tags = memory.tags ?? [];
      const pinned = tags.includes("confucius:pinned");
      const fromLog = tags.includes("promoted-from-log");
      title.textContent = `${pinned ? "★ " : ""}[${memory.type}] ${durableExcerpt(memory.title)}${
        fromLog ? ` · ${getString("workspace-memory-from-log")}` : ""
      }`;
      const body = el(doc, "div", { fontSize: "12px" });
      fillAnswerHtml(body, durableExcerpt(memory.content));
      const del = el(
        doc,
        "button",
        {
          border: "none",
          background: "transparent",
          color: "#b3452f",
          cursor: "pointer",
          font: "inherit",
          fontSize: "11px",
          padding: "0",
        },
        { type: "button" },
      );
      del.textContent = "forget";
      del.addEventListener("click", () => {
        void (async () => {
          await rpc("memory/delete", { id: memory.id });
          await refreshMemories();
          renderKnowledgeWindow();
          renderLists();
        })();
      });
      card.appendChild(title);
      card.appendChild(body);
      card.appendChild(del);
      pane.appendChild(card);
    }
```

并在打开知识库窗口时确保记忆已加载：`renderKnowledgeWindow`（或其打开入口）首次打开时 `void refreshMemories()`。

- [ ] **Step 4: 本地化与样式清理**

两个 `addon.ftl` 删除：`workspace-toggle-review`、`workspace-review`、`workspace-empty-review`、`workspace-review-grip`。
`workspace.css` 删除/替换引用 `.pane-review`、`.review` 的规则（若其他选择器共用，仅删 review 部分）。

- [ ] **Step 5: 同步测试**（`test/workspace-document.test.mjs`）

用例 `pending write approvals automatically reveal the review pane` 改写为：

```js
test("pending approvals render as timeline cards", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("renderApprovalCard"), true);
  assert.equal(view.includes("newApprovalsArrived"), true);
  assert.equal(view.includes("showReview"), false);
  assert.equal(view.includes("reviewPane"), false);
});
```

用例 `settings are tabbed with font appearance controls and resizable review pane` 改名为 `settings are tabbed with font appearance controls`，删除三行 review-grip/col-resize/rememberedReviewWidth 断言。
若其他用例断言了 `workspace-toggle-review` 等，一并更新。

- [ ] **Step 6: 验证与提交**

Run: `npm run typecheck -w @confucius/zotero-addon`
Run: `npm test -w @confucius/zotero-addon`
Expected: 全部通过

```bash
git add apps/zotero-addon/src/modules/ui/WorkspaceView.ts apps/zotero-addon/addon/locale/en-US/addon.ftl apps/zotero-addon/addon/locale/zh-CN/addon.ftl apps/zotero-addon/addon/content/workspace.css apps/zotero-addon/test/workspace-document.test.mjs
git commit -m "feat(addon): inline approval cards in timeline, drop review pane, move memory to memory page"
```
