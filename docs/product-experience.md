# Product surfaces and navigation

Confucius follows Zotero's appearance setting, including the system theme when Zotero is set to automatic. Light mode uses warm white surfaces and brown text; dark mode uses warm charcoal surfaces, ivory text and a soft gold accent. Menus share one floating surface; ordinary actions use borderless buttons. Filled regions indicate selection or editable content. Borders are reserved for evidence tables and quotation markers, rather than nested cards and icon frames.

Settings → Appearance offers Follow Zotero, Light and Dark. A selection previews immediately; Save persists it across windows and restarts, while Cancel restores the saved theme. The same choice is available in Zotero's Confucius preference pane. This setting changes Confucius surfaces only. The send button uses a rounded vector arrow with a fixed optical size, independent of the selected text font.

The logo keeps the same transparent vector silhouette in both themes. `favicon.svg` selects dark ink (`#201D1A`) on light surfaces and warm white (`#F5F1E8`) in dark mode, including live theme changes and a system-color fallback for high contrast. `favicon-light.svg` and `favicon-dark.svg` provide fixed variants. The inline workspace mark inherits the surrounding text color, so it follows the surface it is actually displayed on.

`workspacePalette.css` defines the shared light, dark and system high contrast colors. It loads before the standalone workspace mounts and applies only to Confucius surfaces, including portalled menus and the active native preference pane. Theme changes use CSS media queries without remounting the view, so drafts, selection, keyboard focus and reading position stay in place. Images, PDF content and annotation colors keep their original appearance.

`workspaceSurface.ts` loads the palette and defines shared controls, including the native Zotero preference pane. `workspaceTheme.ts` contains workspace and reading components. `workspaceControls.ts` owns dialog focus handling, tab navigation and anchored task actions. Scrollbars remain in `workspaceScrollbars.ts` so the same thin, stable rails apply to both the sidebar and separate windows.

Settings have a fixed header and footer with independently scrolling content. The last category is retained when reopening settings; arrow keys navigate categories. Model capacity and output limits are disclosed on demand. Saving reports completion and prevents duplicate submissions while a save is pending.

Text controls grow with their content instead of inheriting Zotero's native single-line height limits. Task and knowledge lists use separate title, metadata and row spacing; settings navigation reserves space at scroll boundaries. Pointer clicks show the selected or hover state, while keyboard navigation uses an inset focus outline. Icon and composer controls retain their explicit aligned sizes.

Knowledge entries open in reading mode. Editing is explicit, and switching entries, filters or views retains unsaved form values in `WorkspaceFormDrafts`. Drafts belong to the current workspace UI and are not durable knowledge entries; only Save writes them to the knowledge base. They do not survive an application restart. In a narrow workspace, Back navigates from reading/editing to entries and then topics. Pending loads cannot replace a newer selection.

Task action menus use the same surface and Escape behavior as composer menus. Search can hand keyboard focus to task results. Settings, knowledge and artifact dialogs keep Tab navigation inside the dialog and return focus on closing. Reading an older part of a conversation never follows incoming output automatically; Back to latest resumes following the bottom.

The composer keeps its fixed 108 px text area, Chinese composition handling and model-specific reasoning choices. User font and line spacing preferences apply to reading surfaces. Artifact revisions retain separate reading positions and use the same lightweight menus for switching files and versions.

Plan mode and research presets appear as independent status chips beside the composer’s plus button. They share the toolbar control height and a fixed icon slot. Hovering previews a close icon for 1.6 seconds; clicking once dismisses that state and retains the draft and sources. Keyboard users can activate the button normally or press Delete / Backspace. State changes finish before sending is enabled, and a failed update leaves the chip visible.
