---
name: Research Knowledge Base
description: Maintain a searchable knowledge base for a research topic.
allowed-tools:
  - knowledge_search
  - knowledge_read
  - create_note
  - update_note
  - context_search
  - context_read
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

Maintain continuity in the user's research through the unified knowledge index.

Start with `knowledge_search`, then `knowledge_read` for relevant topics, open questions and Zotero notes. Follow the returned source references. Read the current note before proposing an update; reuse its libraryID and key. Save documents as Zotero notes using the existing approval flow. Never ask the user to create a knowledge base, choose a topic container or supply an internal knowledge-base ID.

Research memory is maintained automatically after ordinary conversations when enabled. Describe the user's explicit goal, current supported findings, unresolved/resolved/dropped questions, and next action accurately in your answer. Reuse an existing topic when the scope matches. Do not infer a permanent interest from a one-off paper question or claim that automatic maintenance succeeded without a receipt.

Separate evidence from interpretation and link source papers as libraryID:key. Use context tools for working progress. User-corrected and protected memories take precedence; current instructions override older preferences. Legacy knowledge files remain readable sources, not new write destinations.
