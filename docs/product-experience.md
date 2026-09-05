# Product surfaces and navigation

Confucius uses warm white surfaces, brown text and a restrained warm accent. Menus share one floating surface; ordinary actions use borderless buttons. Filled regions indicate selection or editable content. Borders are reserved for evidence tables and quotation markers, rather than nested cards and icon frames.

`workspaceSurface.ts` defines the product tokens and shared controls, including the native Zotero preference pane. `workspaceTheme.ts` contains workspace and reading components. `workspaceControls.ts` owns dialog focus handling, tab navigation and anchored task actions. Scrollbars remain in `workspaceScrollbars.ts` so the same thin, stable rails apply to both the sidebar and separate windows.

Settings have a fixed header and footer with independently scrolling content. The last category is retained when reopening settings; arrow keys navigate categories. Model capacity and output limits are disclosed on demand. Saving reports completion and prevents duplicate submissions while a save is pending.

Knowledge entries open in reading mode. Editing is explicit, and switching entries, filters or views retains unsaved form values in `WorkspaceFormDrafts`. Drafts belong to the current workspace UI and are not durable knowledge entries; only Save writes them to the knowledge base. They do not survive an application restart. In a narrow workspace, Back navigates from reading/editing to entries and then topics. Pending loads cannot replace a newer selection.

Task action menus use the same surface and Escape behavior as composer menus. Search can hand keyboard focus to task results. Settings, knowledge and artifact dialogs keep Tab navigation inside the dialog and return focus on closing. Reading an older part of a conversation never follows incoming output automatically; Back to latest resumes following the bottom.

The composer keeps its fixed 108 px text area, Chinese composition handling and model-specific reasoning choices. User font and line spacing preferences apply to reading surfaces. Artifact revisions retain separate reading positions and use the same lightweight menus for switching files and versions.

Plan mode and research presets appear as independent status chips beside the composer’s plus button. They share the toolbar control height and a fixed icon slot. Hovering previews a close icon for 1.6 seconds; clicking once dismisses that state and retains the draft and sources. Keyboard users can activate the button normally or press Delete / Backspace. State changes finish before sending is enabled, and a failed update leaves the chip visible.
