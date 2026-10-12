# Conversation sidebar typography — 2026-10-12

Original language: English.

## Source and scope

Local working-tree changes based on
`1f999e88d0e73c74f6afee7554b25c83e300d9a1`, following the
[earlier UI audit](ui-quality-2026-10-12.md). No new version or release was
published. Public `v0.6.1` source/assets remain unchanged; fixes are under
[Unreleased](../../../CHANGELOG.md).

The ordinary local XPI has SHA-256
`365a68b2b9eacdc8db3a90fc7447fdbcc01a579c8e2f06484218b40084a6503a`.
It retains development version 0.6.1 and is not a replacement public package.

## Behavior

- A docked conversation list grows from 248px to at most 384px with larger fonts.
  It leaves at least 512px for the conversation; smaller workspaces use a drawer
  bounded by available width. Font changes update layout without a resize and
  preserve an already open list.
- Search inputs use native intrinsic height for actual font metrics. Tabs,
  conversation rows and article headers use automatic heights, readable padding
  and 34px minimum targets. Rows have 4px gaps and shared radii.
- At 20px and above, titles show up to two lines. Task actions and article
  creation use fixed 20px SVGs in 34px targets.
- Keyboard scrolling accounts for the actual sticky navigation height. The
  existing ResizeObserver watches typography/navigation and is disposed with
  the view; idle polling does not measure font layout.

## Validation

Environment: macOS 26.6.2, ordinary XPI installations in isolated Zotero 10.0.6
profiles, synthetic conversations and one test article. No external model or
CLI calls. Personal data and preferences were not used.

The earlier local package was surveyed in 32 layout cases. At 28px, its list
remained 248px wide and its search/row boxes remained 32px high despite text
line heights of about 41px.

The current package passed 96 cases: English/Chinese, light/dark,
12/17.5/24/28px, 1200/800/280px windows, and time/article organization.
Checks cover overflow, native input metrics, title height, tabs, article headers,
SVG geometry and sticky-header spacing. Additional checks passed for font-only
dock/drawer changes, retained open state, keyboard navigation, system high
contrast and the actual docked Zotero sidebar.

For the comparable 28px Chinese/light sample, the list is **384px** wide, search
is **52px** high and a two-line conversation row is about **90px** high. Icons
remain 20×20px, centered in 34×34px targets. Wide/narrow and light/dark screenshots
were inspected.

The existing sidebar interaction suite passed **29 groups and 615 clicks**,
including filtering, folding, focus, delayed task responses, pointer stability,
creation/deletion races, action menus and preference restoration.

Commands completed:

```sh
npm test
npm run typecheck
npm run lint
npm run build --workspace=@confucius/zotero-addon
node scripts/live-sidebar-typography.mjs
node scripts/live-sidebar-navigation.mjs
```

The offline suite passed **1,379 tests**, with zero failures, skips or
cancellations. Typecheck, lint and addon build passed. Raw survey results,
native profiles, screenshots and logs remain under ignored `output/`.

Native geometry and keyboard checks used privileged automation. Windows,
Linux and Zotero 7/8/9 were not tested on real devices for this change.
