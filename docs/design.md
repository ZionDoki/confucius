# Interface design rules

English · [简体中文](design.zh-CN.md)

Use the main app's workspace toolbar, timeline, and composer as the visual baseline. Artifact readers, detached windows, sidebars, and overlays follow the same rules. Check the relevant rules before editing UI and complete the checklist afterward.

This is the shared source for colors, spacing, and buttons, linked from the [user guides](README.md) and [maintainer guides](../.github/maintainers/README.md). Do not maintain a separate reader design system.

## Colors

Use semantic variables from [workspacePalette.css](../apps/zotero-addon/addon/content/workspacePalette.css). Do not hardcode hex/RGB colors or create a separate dark palette. Colors follow Confucius appearance settings and support system dark mode and high contrast.

The shared palette handles both `forced-colors` and `prefers-contrast: more`. Zotero chrome uses the latter to select system colors. Overlays keep structural boundaries; waiting indicators disable decorative animation.
Primary actions use the paired system `Highlight` / `HighlightText` colors in contrast mode, with a contrasting keyboard focus ring.

| Purpose                        | Variables                                                        | Use                                                         |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Page, toolbar, reading surface | `--confucius-paper`                                              | Continuous toolbar and body background                      |
| Workspace base                 | `--confucius-canvas`                                             | Timeline surroundings and task sidebar                      |
| Controls                       | `--confucius-surface`                                            | Text buttons, inputs, icon hover                            |
| Control hover                  | `--confucius-hover`                                              | Controls with an existing background                        |
| Menus and dialogs              | `--confucius-elevated`                                           | Actual overlays                                             |
| Body and buttons               | `--confucius-ink`                                                | Primary readable content                                    |
| Secondary text                 | `--confucius-secondary`                                          | Quotes and supporting text                                  |
| Hints and metadata             | `--confucius-muted`                                              | Status, revisions, reference headings                       |
| Links and branding             | `--confucius-accent`, `--confucius-accent-text`                  | Clickable citations, links, branding; not large backgrounds |
| Structural lines               | `--confucius-line`, `--confucius-line-strong`                    | Tables, input borders, quote bars                           |
| Focus and feedback             | `--confucius-focus`, `--confucius-danger`, `--confucius-success` | Keyboard focus, errors, success                             |

PDF annotation swatches, quote bars, and region outlines represent annotation data and retain their actual colors. Keep Zotero's native annotation date display. Record conversation batch times internally without adding or rewriting native tags; do not add a custom batch filter to the PDF toolbar. Reuse the app's existing control semantics without reader-specific accent colors, outlines, or shadows.

## Toolbar and spacing

Width means the available workspace or reader-window width.

| Item                     | Regular: at least 620px                        | Compact: below 620px        |
| ------------------------ | ---------------------------------------------- | --------------------------- |
| Toolbar padding          | 10px vertical, 14px horizontal                 | 8px on all sides            |
| Context and actions      | Horizontal, vertically centered, 10px gap      | Wrapped rows, 6px row gap   |
| Buttons in one group     | 8px gap                                        | 4px gap                     |
| Toolbar minimum height   | 48px; a 34px button plus padding produces 54px | Grows with content rows     |
| Toolbar text buttons     | 13px text, 6px 8px padding                     | 12px text, 6px 8px padding  |
| Very narrow: below 300px | Not applicable                                 | 5px 4px text-button padding |
| Timeline padding         | 18px vertical, 24px horizontal                 | 10px on all sides           |

- Use a 4px spacing unit, with 8px between related controls. Keep the toolbar's specified 10px/14px optical spacing.
- Buttons have zero margin; the parent owns gaps. Do not add native button margins.
- Align peer content. Avoid stacking horizontal padding on a container and its body.
- The compact app action area retains four columns. Reader actions may wrap while keeping the same padding and gaps. Do not shrink text to 10px to force one row.
- Long titles may truncate. Keep button labels readable and allow wrapping with increased height. Reading content is centered, at most 680px wide; compact readers keep 10px side margins.
- Conversation sidebars grow from 248px to at most 384px with larger fonts.
  Keep at least 512px for the conversation when docking; use a bounded drawer
  when both columns do not fit. Typography changes update this layout without
  requiring a window resize. Search, tabs and conversation/article rows grow
  with their text, with 34px minimum targets and 4px row gaps. Titles use up to
  two lines from 20px. Keep 20px SVGs in 34px action targets and account for the
  actual sticky navigation height when scrolling keyboard focus into view.

## Window lifecycle

- A detached Confucius workspace belongs to the Zotero library window that opened
  it. Closing that library closes its workspace and disposes the view, including
  draft saving, polling, listeners and overlays. Closing a different library
  window does not close this workspace.
- Closing a workspace does not cancel host tasks. Host request deadlines, retries
  and state saving use timers independent of UI windows. Reopening a library and
  its workspace restores saved tasks and drafts.

## Buttons and interaction

- Text buttons use `createWorkspaceButton` / `.confucius-button`: 8px radius, `surface` background, `ink` text, weight 550, and `hover` background on hover.
- Toolbar text buttons are 34px high, sharing the app's New task sizing. Wrapped compact reader buttons may grow but remain at least 34px high.
- Icon buttons use `.confucius-icon-button`: 34px × 34px, zero padding, 8px radius, transparent background, `ink` color, `surface` hover, and a 20px icon slot.
- Disabled text buttons use the shared `opacity: .48`, default cursor, and no hover feedback. Their `title` explains the actual reason, such as a running task, pending confirmation, or empty content.
- Icon buttons have both `title` and `aria-label`. Keep visible keyboard focus and keyboard menu navigation.
- Task action buttons use a fixed 20px SVG icon with `currentColor`; font changes
  must not alter the icon's dots, alignment or geometry.
- In settings and review overlays, pointer interactions do not add an outer focus outline to sliders, checkboxes, radio buttons, color swatches or select menus. Keep visible keyboard focus, checked/selected states, color-swatch boundaries and text-input focus/error feedback.
- Do not override shared radii, font weights, or state colors in readers. Before adding controls, check [workspaceSurface.ts](../apps/zotero-addon/src/modules/ui/workspaceSurface.ts) and [workspaceTheme.ts](../apps/zotero-addon/src/modules/ui/workspaceTheme.ts).

## Conversation selection and editing

- Conversation text is selectable. Ctrl/Cmd+C copies the selection without
  interfering with text inputs. Preserve selected passages and reading position
  during stream updates, including selections across multiple entries; refresh
  them when the selection ends.
- Each sent user message offers shared 34px Copy and Edit icon buttons, with
  titles, accessible labels and keyboard focus. Copy uses only its original text.
  Disable editing while a task is running and explain that it must be stopped.
- Edit uses an inline textarea, shared colors, 8px spacing, and wrapping Cancel
  and Confirm and resend buttons. Explain the truncation and the fact that saved
  library changes are not undone. Nothing is sent before confirmation; Enter
  inserts a newline, Escape cancels, and IME composition cannot submit or cancel.
  Polling and blur preserve the draft. Prevent empty and duplicate submissions.

## File drop

- Sent attachments belong beneath the text of their user message. Reuse the
  composer's file labels and metadata with shared colors; omit removal actions
  from sent files. File names wrap at narrow widths and larger font sizes.
  Pending messages use the submitted file snapshot and yield to the durable
  host event without duplicating the message.
- Show the chat attachment hint inside the composer card, using an opaque shared
  background and a structural dashed border. Surrounding workspace drags may
  reveal the hint; only a drop inside the composer card adds an attachment.
- Literature PDF drops belong to the specific paper's dashed target. Hovering
  within a review overlay keeps composer feedback hidden and highlights that
  paper's target. Feedback is local and pointer-transparent; the workspace
  remains readable and usable.
- Clear composer feedback on every drop, including drops handled by nested
  targets, and on drag cancellation, Escape, window exit or loss of focus.
  Dispose the drag listeners with the workspace.

## Model catalog picker

- Use an input and a list inside the dialog. Filter by model ID, name, or provider; avoid native `select` popups that overflow Zotero chrome.
- Reuse settings selection rows, with name and provider/model ID on two lines. Long text wraps. Use `paper`, 8px radius, and a structural border; cap list height at 280px or 36% of the viewport. Scroll inside the list without covering the toolbar, settings footer, or window boundaries.
- Keep focus in the filter input. Arrow keys browse, Enter selects, and Escape closes the candidate list first. IME composition must not trigger queries or selection. Selection shows a configuration preview; Apply writes to the form.
- API protocols and thinking-parameter formats use separate wrapping radio groups
  of shared buttons, not native popups. Support arrow keys and a single tab stop
  per group. Hide format overrides for protocols with native reasoning fields;
  importing model catalog settings preserves the endpoint's protocol choice.

## Reading surfaces

- No decorative bottom border on the toolbar or top border on references. Markdown `hr` keeps 24px vertical spacing but has zero height, no border, and no background line.
- Literature-map entries, annotation legends, and annotation lists also omit decorative horizontal rules.
- Separate sections with whitespace and text hierarchy. Leave 40px between body and references.
- Keep structural table lines, quote bars, annotation marks, and region outlines.
- Present the body as a continuous surface without an outer frame, card background, or decorative shadow. Show a clear empty state.
- Suppress the full outline on the focused body scroll container to avoid Gecko drawing a line under the toolbar. Keep keyboard scrolling and visible focus on buttons, links, and menus.
- Titles wrap with zero letter spacing. Body text follows the user's font, size, and line height.

## Native PDF annotations

- Native annotation cards and comment popups share the saved Confucius font,
  font size, reading line height and palette by default. Appearance settings can
  override annotation font size, line height and paragraph spacing independently
  of chat and reports. Scope these tokens to annotation
  surfaces; PDF pages and the rest of Zotero retain their own appearance.
- Comment popups use the shared elevated background, shadow and 14px overlay
  radius, with a 420px preferred width and at least 8px of space inside each
  reader pane. Keep the native header and tags reachable while long comments
  scroll; code, tables and display formulas scroll horizontally within the body.
  Place Edit comment in the popup header immediately before the native three-dot
  menu. Keep both actions on one row; the header can wrap above them in narrow
  panes. Hide the edit action while the native editor is focused.
- Each popup corner has a 24px resize target with a small shared-color corner
  mark and a directional cursor. Dragging keeps the opposite corner anchored;
  arrow keys resize by 8px (24px with Shift). Double-click or Enter restores the
  automatic size. Escape retains native popup dismissal. Keep the chosen size for the
  current reader session, bound it to the pane and retain reachable header,
  editing and tag controls. Remove handles and drag listeners on unload.
- Cards use the paper background, 8px radius, whitespace and a quiet selected
  state. Preserve actual annotation colors and native dates, locators and tags.
  Do not replace native header, context-menu or Flex Annotations nodes.
- Render Markdown and math in an owned preview beside the native comment
  editor. Edit comment restores native editing; blur returns to reading.
  Preserve native Escape handling, IME composition, selectable
  preview text, links, read-only behavior and source contents. Unloading the
  plugin removes its previews and styling.

## Report style picker

- Show the composer entry only for the Paper review preset. Hide it without leaving space when the preset is cleared or changed. Match composer controls: 36px high normally, 32px in very narrow layouts. Keep the label on one line; wrap the whole left control group when needed without overlapping the model or Send button.
- Layout, tone, and reading focus each use three borderless radio cards. Cards are transparent; selection uses `surface` and a radio dot. No decorative dividers.
- Use 8px group gaps and 12px card padding. Narrow overlays use one column and 4px gaps. Reuse app buttons, allow vertical dialog scrolling, and wrap English and Chinese labels.
- Arrow keys change the option within a group, Tab moves between groups, and Escape cancels. Canceling does not send the draft.
- Previews use the report's layout rules. Source and explanation columns use whitespace and stack on narrow surfaces. Expandable supplements sit beside the relevant paragraph; essential reasoning and evidence limits stay in the body.

## Selection questions

PDFs, reports, and conversations share one popover. Show a single-line question input near the selection using shared `surface`, `ink`, `line`, and focus variables. Its minimum height is 34px; it grows with larger fonts and keeps the popover within the reading bounds. Do not add a toolbar or extra buttons.

The answer opens above the input, using the reading font, size, line height, and shared overlay background and shadow. Long answers scroll inside. Use 12px body padding, 20px between follow-ups, and 8px around the expanded input. Questions use secondary color and slightly smaller text. Code and tables scroll horizontally in their own regions; no decorative dividers.

Cap width at 420px. Narrow windows retain at least 8px on both sides. Position within the available reading area. Outside clicks or Escape close the popover while the answer continues and is saved. Opening it does not steal focus from the source selection. Enter/Escape during IME composition must not send or close. Selecting answer text pauses replacement of that passage until selection ends.

## Literature and subagents

### Task grouping and capsules

- By article groups tasks by their paper at creation. Later materials, confirmed candidates, and turns do not change that group. Searches started from a blank task appear in Literature research without creating one group per result. Research started from an article remains under that article. By time shows each task once.
- Each task has one literature capsule; further searches update its result pool. Keep tool activity in the timeline without duplicate literature cards. Hide the entry before any search; a zero-result search still exposes it so users can adjust the query.
- Display counts such as “Candidate papers: 9 / 100”: selected candidates over papers actually retrieved and deduplicated for this task, not the API's total hits. Explain counts in the overlay; keep full-text and confirmation status inside it.
- Literature, annotation, and Back to latest controls share one row above the composer, aligned to its edges, at most 880px wide and 8px above it. Capsules occupy the left; reserve 34px for the right icon button with an 8px gap. Capsules may wrap. Hide the row when empty. Only one literature or annotation overlay opens at a time.
- Capsules have a minimum height of 34px, 12px text, 24px radius, shared elevated background, and a light shadow. Reuse shared button weight, hover, and focus. Icons/arrows use fixed centered 16px slots; opening only rotates the arrow. Long labels may wrap, but keep counts together without shrinking text or changing the target. Back to latest uses the 34px shared icon button.

### Literature overlay

- Literature candidates and annotations use one review component and view model,
  with domain adapters for decisions, source opening and acquisition controls.
  The first nonempty pool defaults to cards below ten entries and a list at ten
  or more. Preserve manual presentation choices on filtering, refreshing,
  arrivals and task revisits. Both domains share card height, edge navigation,
  completion-time opening, coalesced 6px/1.12× reminders and reduced-motion behavior below. A blocking literature confirmation opens immediately, including while the Agent is running.
- Open an opaque overlay above the row, aligned to the composer's left edge, at most 680px wide. Compact windows keep composer margins. Height follows available timeline space. Use `elevated`, 14px radius, shared shadow, fixed header/footer, and a scrolling list; the composer stays usable.
- Use 14px titles, 13px content, 12px metadata, and 16px vertical/20px horizontal padding, reduced to 12px in compact layouts. Reuse shared buttons.
- Preserve candidate selection, filters, abstracts, and list scroll across closing/reopening. Opening pauses main-timeline auto-follow without moving the conversation. Outside clicks/Escape close without stopping work or stealing outside focus. Back to latest closes the overlay and scrolls to the conversation end.
- Query controls and local filters are secondary entries. Organize paper rows with whitespace; align checkboxes with the title's first line.
- The shared status menu filters unreviewed, included, excluded or all papers.
  Include/Exclude act on the card or selected list rows; checking rows is a
  snapshot for bulk decisions. Confirmation shows additions, removals and
  acquisition scope in the shared content area. Confirm and acquire fulltext
  authorizes the versioned batch; changed versions require review again.
  Full-text state is independent of candidate choices. PDF drop targets use
  structural dashed borders and highlight the specific target.
- The footer offers Continue with abstracts before confirmation and Continue with current results afterward. Show full-text and abstract coverage against candidate count, plus library-import and background-download behavior. Search, abstract lookup, or a single PDF import must not disable Continue. Stale confirmation previews require review.
- Keep concise coverage labels, fixed header/footer, and list scrolling. Allow labels and right-aligned button groups to wrap in narrow windows.
- Reserve at least 48px for a scrollable list. Narrow candidate footers prioritize
  action buttons; fulltext/abstract coverage stays reachable in the footer.
  Below 340px, detailed Continue help remains in its tooltip and accessible
  description. If controls exceed a short overlay, scroll inside the overlay
  instead of clipping them.
- After current materials are accepted, hide Continue. When full text is still missing, show only a secondary Get remaining full text link with shared link-button styling and focus. Hide it when complete or downloading. Candidate changes restore confirmation for the new version.

### Venue ratings

- Cards and list rows use the same rating component, immediately below venue
  metadata. Show system, grade, catalog year and an actionable source link.
  Use quiet wrapping badges with shared surface/ink/secondary variables, 12px
  metadata, 8px gaps and no grade-specific colors or decorative dividers.
- Keep every subject's quartile in an initially collapsed detail area, along
  with major/minor category, Top, impact factor, position, import filename and
  the pinned source snapshot when present. Expanded rating and abstract details
  retain their own state on metadata refreshes.
- Put CSV import/removal in Runtime settings and a secondary collapsed review
  tool. Closed review tools share a wrapping row; an expanded tool uses the full
  row to retain space for results. Reuse workspace buttons and parent-owned gaps; loading/error feedback
  uses a polite status area. Cancellation and errors preserve the old catalogs.
- Unknown ratings use a quiet unmatched label, without equating missing data
  with an unranked venue. Import refreshes must preserve current card, scroll,
  filters and candidate selection and must not replay an arrival reminder.

### Subagent entries and viewer

- Place each subagent entry at its delegation point, showing icon, name, state, and latest activity/tool count. Updates do not move it. Avoid duplicate ordinary tool blocks for delegation; retain error feedback.
- Entries span the chat content column. Use shared button colors, hover, focus, and weight, two text rows, 10px vertical/12px horizontal padding, and a fixed 18px icon that does not shift on interaction. Run at most three subtasks; queue the rest.
- All subagents share one fixed centered viewer. Its position and size do not depend on the entry, content, or main scroll. Clicking the same entry closes it; another switches it. Previous/Next follow task order and show position.
- Keep each subtask's filters, expanded items, loaded archives, and scroll when switching. Mount and refresh only the current content.
- Viewer size is 680px × 640px, shrinking to viewport minus 16px with at least 8px margins. Reuse the literature overlay's palette, radius, fixed header/footer, scrolling, padding, and 14px/13px/12px text sizes.
- Share main-chat message rendering: instructions use user-message style; answers render Markdown, links, and math. Public progress summaries switch between a three-line preview, full view, and one-line collapse with keyboard support. Tools show grouped summaries, then per-call input, progress, and full output. Filtering matches individual calls without expanding unrelated ones.
- Keep text contrast in previews; do not fade short content with gradients. Reopening shows newly arrived results. Calls without receipts after retry or a finished execution display Interrupted, not Running.
- Use the main chat's waiting indicator during model activity and remove it afterward. Keep one conclusion in the original timeline without another result card.
- Raw events and paged evidence archives stay in a secondary collapsed area at the bottom. Do not add a chat input or record hidden model reasoning.
- Appending events preserves expansion, text selection, and reading position; follow only at the end. Opening pauses main-timeline auto-follow. Closing, Escape, and outside clicks do not cancel; Stop and Retry are explicit actions.
- Load long traces in batches and show loaded event counts. Filter locally after IME composition ends. With no new events, preserve content. Stale responses must not roll back archive pagination or steal another task's focus.
- Literature and subagent controls share light/dark variables. Wrap in narrow windows without shrinking readable text; hidden controls occupy no space. Closing the workspace removes listeners and overlays without canceling host tasks.

## Annotation review

- Reuse the same component as literature candidates. Initially use cards for
  fewer than ten entries and a list from ten; completion/history behavior below
  still applies. Domain adapters retain annotation receipts and ownership checks.
- Each submission creates an independent review batch. Each task has one annotation capsule in the shared composer row. Reuse literature capsule styling, 34px minimum height, 12px text, and 24px radius. Show pending/writing/needs-attention counts, then a handled total.
- Live batches update quietly while the Agent runs; users may open them at any time. When generation ends, flush pending arrivals together: the first suggestions open review without taking keyboard focus or interrupting composition. Loading history starts minimized. Two icon buttons switch between cards and list. Cards use `elevated`, 14px radius, and two stacked paper layers; no glass edges, translucent backgrounds, or blur. Use actual annotation color only for the source quote bar.
- Cards fill the remaining overlay height below its header and batch selector and above its footer. Keep card metadata and decision controls fixed; long source text scrolls inside without hijacking text scrolling.
- Cards support edge clicks, horizontal dragging, wheel navigation, and a native range slider with arrow-key support. Hovering or focusing a card reveals narrow left/right gradients and direction arrows in reserved edge gutters, without masking its text or controls. Show only available directions; keyboard focus stays usable at the first/last card. Use shared colors, 34px edge targets (44px on touch), persistent cues without hover or in high contrast, and no decorative motion with reduced motion. Accept/Reject use shared 34px controls and fixed icon slots.
- Cards/list share the literature overlay's 680px maximum width, opaque background, 14px radius, and shadow. Opening, switching, and minimizing must not change capsule-row or composer height. Fix header/footer, scroll the body, and group batches with whitespace.
- Use one search field and one batch/status menu. Show bulk actions only after selection. Virtualize long lists.
- Later live batches preserve minimized/expanded state, current card, search, selection, and scroll. Float the whole capsule up 6px and enlarge it to 1.12× once, using the shared overlay shadow to suggest elevation, then smoothly return it to rest. Anchor the scale at its left center and preserve layout dimensions; its pointer target follows the visible capsule. Coalesce arrivals during generation and play once when it ends, even if there is no new review event. Reduced motion and high contrast use the static new count and polite announcement instead. Update counts and offer View new without forcing open. History, repeated events, duplicate submissions, and write receipts do not replay the notification. Bulk selection is a snapshot; later arrivals do not join automatically. Keep per-batch view state.
- Mark Written only after a real write receipt. Rejection is reversible. Distinguish failed writes from outcomes needing verification. Unlocatable proposals may still be rejected; restoring them retains the unwritable state and reason. Do not retry uncertain writes automatically. Page buttons open the source; written items can open native annotations.
- Show Current proposals handled only when every arrived proposal is written or rejected. This describes review progress, not agent completion. An empty filter, active write, failure, uncertain outcome, or unlocatable proposal is not completion. Keep receipts and Done and minimize; reopening shows the review history.
- Always keep the `—` minimize control, including during writes. Clicking the capsule, outside, or Escape also minimizes; close menus first. Preserve background writes and view state. Receipts update results without reopening.
- Keyboard closing returns focus to the capsule; outside clicks retain outside focus. Pause main auto-follow while open. IME composition must not filter or close. Back to latest also minimizes the overlay.

## Knowledge and file export

- Provide one search entry and source list for Zotero notes, research topics, preferences, ordinary memories, and legacy knowledge files. No topic-container editor or knowledge-base ID input. Selecting an entry reads its actual source.
- Use side-by-side list and reader normally; stack below 620px, with independent scrolling. Follow shared toolbar padding, buttons, palette, and reading rules, without decorative body dividers.
- Notes offer Open in Zotero and Export file. Research memories offer Correct memory and Forget. Preserve focus and drafts during correction; background refresh must not overwrite an edit. Search supports IME composition.
- Reading outputs default to Zotero notes; omit a destination menu with only one option. Export uses shared buttons in the same group without global format or storage-channel settings.

## Settings

- Use horizontally scrolling top tabs at every width. Workspace settings keep header, tabs and footer fixed while the content scrolls. Zotero preferences keep tabs and Appearance actions visible as the pane scrolls. Appearance columns stack with narrow widths or large fonts.
- Appearance controls edit a draft without a preview. Save applies the complete appearance; cancelling discards the draft. Reset defaults also requires Save.
  During a save, temporarily prevent further edits, cancellation and duplicate submissions; restore interaction after success or failure.
- Use paired slider/number inputs for 12–28 px font sizes (0.5 px steps) and 1.2–2.4 reading line heights (0.05 steps). Font selection offers searchable presets and actual installed families with system fallbacks.
- Edit light/dark palettes independently of the active theme. Custom colors use the existing paper, canvas, surface, ink, secondary and accent tokens; derive hover, focus and selected states from them. Default colors come from the shared palette stylesheet. System contrast overrides customization.
- Reuse the Appearance and Runtime editors in workspace settings and Zotero preferences. Group Runtime connections by backend with state and next action; keep paths in connection details and retrieval/storage tools collapsed. Connection actions clearly apply immediately.
- Both settings entry points use the same button states, 34px minimum text-button height, zero button margins and parent-owned 8px gaps. Native sliders, color swatches and check controls keep their interaction without inheriting text-input geometry. Slider/number rows stack when space is tight.
- Confucius preferences content follows the saved palette even when Zotero uses the other theme. Scope its background and control styles to the active Confucius pane; other preference panes retain Zotero's appearance.

## Review checklist

1. UI colors come from shared variables; annotation colors still reflect data.
2. Regular, compact, and very narrow toolbars match the spacing and button sizes above.
3. Long English/Chinese labels and larger fonts do not overlap, clip, or cause window-level horizontal overflow.
4. Reader toolbar, references, Markdown rules, and lists have no decorative lines. In Zotero, check first opening and refocusing for unwanted body outlines; tables and quotes remain legible.
5. Empty/disabled states explain why. Hover, focus, and keyboard menus work.
6. Light, dark, and high-contrast modes remain readable. Distinguish automated checks from real Zotero testing.
7. Run `npm test` and `npm run typecheck`; never report unrun checks as passing.
