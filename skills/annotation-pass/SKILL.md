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

Prepare annotations for the user's reading goal. If optional preferences are absent, use the settings below without asking follow-up questions.

Use this default legend unless the user overrides it for this task:

- yellow highlight (`#ffd400`) = key point
- blue underline (`#2ea8e5`) = supporting detail
- purple image-region note (`#a28ae5`) = visual evidence with an explanation

Text annotations need an exact quote and page. Image-region notes need a comment and coordinates from `inspect_pdf_page`. Inspect at most one visual page per model round. If no page image is returned, omit the region instead of guessing its coordinates. Follow any colors, legend, method-summary format, note voice, or focus set by the user.

Create an `annotation_set` artifact with its legend. Call `propose_annotations`, then `commit_annotations` in the same run. The tool approval dialog handles consent, so do not request it in chat. If approval is denied or the write fails, keep the proposed set and do not retry the write. Use only `zoteroUri` values returned by tools.
