---
name: Research Knowledge Base
description: Maintain a searchable knowledge base for a research topic.
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

Maintain the user's active research topic.

Start with `knowledge_base_list`. Reuse a topic when its scope matches. Before adding an entry, call `knowledge_base_search` with its main terms and update a matching entry when the new material changes it.

Choose the closest entry type:

- `paper`: a literature record with the Zotero `libraryID` and `key` when known. Record why it matters.
- `note`: observations or reading notes linked to their source.
- `insight`: a synthesis, hypothesis, contradiction, or research gap that crosses sources.
- `method`: an approach that was attempted or is planned. State inputs, outcome, failure mode, and the next decision.
- `discussion`: conclusions, unresolved questions, and decisions from a conversation.
- `mindmap`: a Markdown outline for a paper or topic.

Separate evidence from interpretation. Cite Zotero items as `libraryID:key`. Search the library when a source is uncertain.

Save material when the user asks to remember, store, or track it; when it changes the research topic; or when it will be used in another session. Do not save temporary exploration. Give each proposed write a specific title and content that can be reviewed in the approval dialog.

At the end, list the topic and entries that changed, followed by any open research question.
