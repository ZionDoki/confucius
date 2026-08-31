# Confucius

Native research agent for Zotero, plus a Chrome side panel that shares the same session.

Confucius is a sibling of Paper Chat. The agent loop runs inside Zotero. The Chrome extension is a client and a browser-context source.

## Install

### Zotero addon

```bash
cd C:\Workspace\confucius
npm install
cd apps/zotero-addon
npm run build
```

Install `apps/zotero-addon/.scaffold/build/confucius.xpi` from Zotero → Tools → Add-ons → Install Add-on From File.

For development: `npm start` in `apps/zotero-addon` (needs a local Zotero 7+ binary).

Then: Settings → Confucius → set **Base URL**, **API key**, and **Model** (OpenAI-compatible Chat Completions with tool calling). Copy the pairing token.

Open the workspace from the Confucius toolbar button.

### Chrome extension

1. `chrome://extensions` → Load unpacked → `apps/chrome-extension`
2. Open the side panel, paste the pairing token, click Pair
3. On arXiv / PubMed / DOI pages, click **This tab** to push identifiers into the session

## What v1 does

- Timeline workspace (not chat bubbles): tools, JSON results, approvals
- Library search, collections, notes, PDF outline/pages/sections
- Writes wait in the Review column (`create_collection`, `add_item`, notes, annotation proposals)
- Skills: Paper Deep Reading, Claim Evidence Audit, Related Work Map, Library Triage, Annotation Pass
- Read-only MCP at `http://127.0.0.1:23119/confucius/v1/mcp` (Authorization: Bearer pairing token)
- Optional extra MCP server JSON in prefs: `[{"id":"scholar","url":"https://..."}]`

## Layout

```
packages/protocol
packages/harness
packages/skill-format
packages/mcp-client
packages/zotero-tools
apps/zotero-addon
apps/chrome-extension
skills/
evals/
```

```bash
npm test
npm run typecheck
```

## License

AGPL-3.0-or-later
