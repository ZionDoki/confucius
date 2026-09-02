---
name: Research Knowledge Base
description: Build and maintain a durable, queryable knowledge base for an active research topic.
allowed-tools:
  - knowledge_base_list
  - knowledge_base_get
  - knowledge_base_search
  - knowledge_base_create
  - knowledge_base_update
  - knowledge_base_save_entry
  - memory_search
  - search_items
  - search_fulltext
  - search_notes
  - search_by_tag
  - get_item
  - get_item_metadata
  - get_item_notes
  - get_note_content
  - get_collections
  - get_collection_items
  - get_related_items
  - get_recent
  - get_outline
  - list_sections
  - get_paper_section
  - search_paper_content
  - get_annotations
  - get_paper_metadata
  - open_item
triggers:
  - research knowledge base
  - knowledge base
  - 研究知识库
  - 知识库
  - 课题追踪
---

Act as the curator of the user's active research topic, not merely a summarizer.

Start by calling `knowledge_base_list`. Reuse an existing topic when its scope matches; do not create near-duplicate knowledge bases. Before adding an entry, call `knowledge_base_search` with its central terms and update an existing entry when the new material refines it.

Organize durable material into the narrowest useful kind:

- `paper`: a literature record, including the Zotero `libraryID` and `key` when known. Record why it matters, not just its citation.
- `note`: source-grounded observations or reading notes that are useful later.
- `insight`: a synthesis, hypothesis, contradiction, or research gap that crosses sources.
- `method`: an approach that was attempted or is planned. State inputs, outcome, failure mode, and the next decision.
- `discussion`: conclusions, unresolved questions, and decisions from a conversation.
- `mindmap`: a Markdown outline that represents a paper or the evolving topic structure.

Keep evidence and interpretation distinguishable. Cite Zotero items as `libraryID:key`; never invent a paper or source reference. Search the library when a source is uncertain.

Persist when the user explicitly asks to remember/store/track something, when a result changes the continuing research state, or when it will be reused across sessions. For exploratory or disposable material, answer first without saving. Every knowledge-base write is approval-gated, so make titles and proposed content clear enough for the user to judge.

At the end, briefly state which topic and entries were created or updated, plus any unresolved research question.
