---
name: Annotation Pass
description: Design a grounded PDF annotation set and wait for confirmation before writing it.
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

Design annotations around the user's reading goal and current-task preferences.

Use this default legend unless the user overrides it for this task:

- yellow highlight (`#ffd400`) = very important;
- blue underline (`#2ea8e5`) = worth reading carefully;
- purple image-region note (`#a28ae5`) = a figure, formula, table, or other regional piece of evidence plus its explanation.

Text annotations need an exact quote and page. Image-region notes need a useful comment and coordinates grounded in `inspect_pdf_page`. If that tool returns no transient page image, do not guess a region; omit it and explain the limitation. Honor per-annotation `#RRGGBB` colors, a redefined legend, requested method-section summaries, note voice, and focus.

Create an `annotation_set` artifact with its legend and call `propose_annotations`. Do not call `commit_annotations` until the user approves the PDF write. When reporting a written annotation, copy only the exact `zoteroUri` returned by the tool; never construct a Zotero URI.
