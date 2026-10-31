# Conversation PDF binding — 2026-10-31

Original language: English.

[Acceptance archive](README.md) · [Interface rules](../../../docs/design.md)

## Scope and artifact

Unreleased development changes after `b2bba7e`, based on 0.6.4-beta.2. This
record does not change the published Beta's capabilities or its package.

- macOS, Zotero 10.0.7, Node.js 22.23.2.
- Normal XPI installation in an isolated profile and library; the personal
  Zotero profile was not modified.
- Tested development XPI: 881121 bytes, SHA-256
  `78e3bd7bcdc4d39e18641746b0b856b078524a4a3000f6781f64b3118af0cc23`.
- Native Zotero reader tabs, a detached Confucius workspace, two fixture PDFs,
  and a local HTTP model fixture. No paid model or personal papers were used.
- The original card-layout harness was superseded by the inline composer
  acceptance suite for 0.6.4-beta.3. `live-pdf-binding.mjs` now runs that suite.
  Raw logs, screenshots and machine-specific profile paths remain in ignored `output/`.

## Automated validation

- `npm test`: 1686 passed, zero failures.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Regression coverage includes one-time binding, same-PDF page refresh,
  completed conversations, explicit task-entry context, manual unbinding and record migration, preserving
  explicit materials, rejecting changes during a turn, exact attachment IDs,
  standalone PDFs, deleted/non-PDF attachments, search and pagination.

## Real Zotero validation

All nine groups in the isolated acceptance script passed:

1. The current reader is visible before sending and binds when New task is
   clicked. Duplicate source controls are absent from the topbar and task title.
2. Switching reader tabs leaves the conversation's PDF unchanged.
3. The picker switches the exact attachment while preserving explicit materials.
4. Search, IME composition and arrow/Enter selection work without early selection.
5. Sending uses the switched PDF in both the run snapshot and actual HTTP request.
6. Explicit No PDF persists across polling while another reader remains open.
7. Light/Chinese at 14px and 1120px width; dark/English at 28px and 430px width;
   system high contrast; Escape returns focus. No workspace horizontal overflow;
   the picker stays inside the window and retains an internally scrollable list.
8. A delayed save does not reselect its conversation after New task. Sending
   stays disabled until the PDF choice finishes saving.
9. Explicit unbinding survives an ordinary Zotero restart.

The interface checklist was reviewed: shared palette and button geometry, fixed
20px document icon, wrapping/ellipsis with full-title tooltips, 34px minimum
controls, reachable empty/disabled states, keyboard/IME behavior, and contrast.
No decorative reader dividers were introduced.

## Limits

This is local development acceptance, not a new release or public update test.
Windows, Linux, Zotero 7, separate native PDF reader windows, very large libraries,
and screen-reader software were not exercised. Search uses the current library.
