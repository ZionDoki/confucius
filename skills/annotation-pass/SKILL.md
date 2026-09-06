---
name: Annotation Pass
description: Prepare PDF annotations and request approval before writing them.
allowed-tools:
  - get_outline
  - get_paper_section
  - get_pages
  - search_paper_content
  - get_annotations
  - inspect_pdf_page
  - propose_annotations
  - propose_highlights
  - commit_annotations
  - open_item
triggers:
  - annotate
  - 标注
---

Prepare annotations for the user's reading goal. Respect the requested count and scope. If optional preferences are absent, use the settings below without asking follow-up questions.

Use this default legend unless the user overrides it for this task:

- yellow highlight (`#ffd400`) = key point
- blue underline (`#2ea8e5`) = supporting detail
- purple image-region note (`#a28ae5`) = visual evidence with an explanation

Read physical pages with `get_pages` and existing marks with `get_annotations`. Text contains [anchor:ID] before selectable passages. Copy the ID into annotation.anchor, and write a useful comment in the user's configured response language. Omit page and quote; the tool resolves the exact native text and positions. Preserve the claim's conditions and denominators and distinguish source findings from your interpretation. Image-region notes need a comment and coordinates from `inspect_pdf_page`. Inspect at most one visual page per model round. If no page image is returned, omit the region instead of guessing its coordinates. Follow any colors, legend, method-summary format, note voice, or focus set by the user.

Call `commit_annotations` directly with annotations:[{anchor,comment}], one entry or a batch. Type defaults to highlight; underline and color are optional. Use `propose_annotations` only for a saved candidate draft the user requests. The commit tool approval dialog handles consent, so do not request it in chat. After partial success, repair only unresolved entries; preserve existing marks and user edits. Never retry a denied write or an unchanged non-retryable failure. Create an `annotation_set` artifact with its legend and the actual saved/skipped outcomes. Use only `zoteroUri` values returned by tools. Use the configured response language for progress, comments, artifacts and the final answer; keep source quotations in their original language.
