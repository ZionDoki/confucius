---
name: Organizer Assign
description: Assign reading annotations to outline headings via § tags for Flex Annotations Organizer.
allowed-tools:
  - organizer_get_outline
  - organizer_list_annotations
  - organizer_get_annotation_context
  - organizer_assign_annotations
  - organizer_unassign_annotations
  - get_collections
  - get_item
  - open_item
triggers:
  - organizer
  - assign annotations
  - outline assign
  - 大纲归类
  - 大纲整理
---

Assign collected reading annotations to headings in the Flex Annotations Organizer outline.

### Rules and Data Model

- Headings are assigned to annotations as tags prefixed with `§`, e.g. `§Introduction`.
- Outline hierarchy and headings are stored in a note tagged `★outline` and `#flexannotate-outline-<collectionKey>`.
- Headings are arranged hierarchically with dynamic decimal numbering (e.g. `1`, `1.1`, `1.2.3`). When presenting the assignment plan to the user, always refer to headings by their numbered title (e.g. `1.1 Funktionen des Quellennachweises`).
- In tool calls to `organizer_assign_annotations`, either the numbered title (e.g. `"1.1 Funktionen des Quellennachweises"`) or the bare title (`"Funktionen des Quellennachweises"`) can be passed in `headings`.
- Only assign headings that exist in the collection's outline tree.
- If the target collection is a subcollection, it belongs to the topmost collection tree. If that tree is missing, ask the user to create it; do not substitute the library-wide tree.
- Do not create or invent headings. Tree changes belong to the user in the Organizer.
- Leave other tags alone (especially `#flexannotate-*`). Remove `§` tags only on explicit unassign requests.

### Contextual Understanding of the Outline Hierarchy

1. **Inspect the Full Outline Tree:**
   - You must inspect and understand the complete structure of the outline before assigning any annotations.
   - Do NOT evaluate headings in isolation or rely on superficial keyword matching.

2. **Disambiguate Generic Headings via Parents (Hierarchical Scope):**
   - Many subheadings use generic, standard phrasing (e.g. _„Sachlicher und räumlicher Geltungsbereich“_, _„Tatbestand und Rechtsfolgen“_, _„Methodik“_, _„Definitionen“_).
   - In isolation, such titles are agnostic and do not tell you which statute, topic, or theory they relate to.
   - Their precise meaning is determined solely by their ancestor headings in the outline path (for example, `2. Europäische Datenschutz-Grundverordnung > 2.1 Sachlicher und räumlicher Geltungsbereich` vs. `3. Bundesdatenschutzgesetz > 3.1 Sachlicher und räumlicher Geltungsbereich`).
   - Always trace the full hierarchy (`numberedPath` / `path`) to ensure an annotation is filed under the correct thematic chapter.

### Multi-Heading Assignment Rules & Syntax

1. **Tag Syntax for Multiple Headings:**
   - When assigning multiple headings to an annotation, each heading corresponds to its own separate Zotero tag prefixed with `§` (e.g. `§Methodology` and `§Discussion`).
   - In the `organizer_assign_annotations` tool call, pass each heading title as a separate string element inside the `headings` array (without the `§` prefix).
   - Example:
     ```json
     {
       "key": "ANNOTATION_KEY",
       "headings": ["Methodology", "Discussion"],
       "reason": "Covers both the measurement protocol and limits discussed in the findings."
     }
     ```
   - The tool automatically generates and applies the corresponding individual tags: `§Methodology` and `§Discussion`. Do NOT combine them into a single string like `"Methodology / Discussion"` or `"§Methodology, §Discussion"`.

2. **No Hierarchical Redundancy (Strict Ancestor Rule):**
   - NEVER assign both a parent heading and one of its subheadings (e.g. never tag both `1. Main Part` and `1.2 Background`).
   - The Organizer UI aggregates subheadings automatically (`includeSub = true`). Every annotation under a subheading automatically appears under each ancestor heading in the Organizer tree.
   - Always choose only the single most specific heading that fits in that branch.

3. **Cross-Branch Multiple Assignments:**
   - Multiple headings should ONLY be assigned across distinct, non-ancestral branches of the tree (e.g. `Methodology` and `Results`).
   - Only assign multiple headings if the quote and context genuinely support each topic.
   - If several headings fit, choose the single best one rather than tagging all possible matches. If nothing fits, return `headings: []` rather than guessing.

### Workflow & Handling Existing Assignments

1. **Identify the Target Collection:**
   - Resolve the target collection from the user's prompt. Walk to the topmost collection if it is a subcollection.
2. **Inspect the Full Outline Hierarchy:**
   - Call `organizer_get_outline` with `collection: <key or name>`. Thoroughly analyze the entire outline hierarchy, paths, and decimal numbering. Ensure you understand the contextual meaning of each subheading in light of its parent sections.
3. **List Annotations (Standard vs. Re-Check):**
   - **Default (New/Untagged Annotations):** Call `organizer_list_annotations` with `collection: <key or name>` and `unassignedOnly: true`. This retrieves only annotations that do not currently have any `§` tag from this outline, preventing re-processing of already organized notes.
   - **Explicit Re-Check / Review Request:** If the user explicitly asks to review, verify, or reorganize already assigned annotations (e.g. _"Überprüfe auch bereits zugeordnete Annotationen"_ or _"Prüfe, ob meine Zitate an der richtigen Stelle stehen"_):
     - Call `organizer_list_annotations` with `unassignedOnly: false`.
     - Each item returns `assignedHeadings: string[]` detailing its current placement in the outline.
     - Evaluate whether the existing heading is contextually accurate.
     - If an annotation is misclassified and should be moved, call `organizer_unassign_annotations` to remove the outdated heading and `organizer_assign_annotations` to assign the proper heading.
     - If an annotation fits an additional non-ancestor heading, call `organizer_assign_annotations` with the complementary heading.
4. **Context Inspection:**
   - For annotations where the quote or comment is ambiguous, call `organizer_get_annotation_context` with `key` to inspect the surrounding text in the source document.
5. **Propose the Assignment Plan:**
   - Call `organizer_assign_annotations` (and/or `organizer_unassign_annotations`). With Confucius tool permissions set to Ask, this presents an interactive Outline Assignment Review Card to the user with numbered headings (`1`, `1.1`), quote snippets, user comments, short source citations (`📄 Autor (Jahr) · S. X`), and individual accept/reject toggles.
6. **User Review and Commit:**
   - The user reviews the assignments, filters by heading or status, and clicks Apply to commit the accepted assignments to Zotero. An explicit `dryRun: true` remains a preview after approval; use a separate write request to apply it.
7. **Conversational Feedback:**
   - If the user asks for a conversational summary before or after reviewing, reference headings by their numbered title (e.g. `1.1 Funktionen des Quellennachweises`).
