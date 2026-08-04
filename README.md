# Helium Bookmarks Sidebar

A right-edge bookmark sidebar overlay for the **Helium browser** and other Chromium-based browsers. It opens when the pointer reaches the right edge of a normal webpage, displays real browser bookmarks as collapsible folder sections, and can remain pinned.

The extension does not use Chromium's native Side Panel API. It renders an overlay inside a closed Shadow DOM so webpage styles cannot affect it and page scripts cannot read the bookmark titles or URLs rendered inside it.

The visual design follows the `helium-bookmarks-sidebar-210-v10.html` prototype, including the 210 px panel, compact rows, overflow fade, colors, typography, and radii. Hover motion follows Helium's native Zen Mode side-chrome timing.

## Load it unpacked

1. Open `helium://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository folder containing `manifest.json`.
5. Refresh tabs that were already open before the extension was loaded or reloaded.

Move the pointer to the far-right edge of a normal HTTP or HTTPS page. The toolbar action and configured keyboard shortcut open the sidebar and focus search directly.

## Permissions and site access

The extension requests:

| Permission | Purpose |
|---|---|
| `bookmarks` | Read, create, move, and delete browser bookmarks and folders. |
| `storage` | Persist collapsed folders and pinned state. |
| `favicon` | Use Chromium's private `_favicon` endpoint. |

The extension does not declare a separate `host_permissions` key, but its content script runs on all HTTP and HTTPS pages because edge-hover activation must be available on those pages. Chromium may display this as site access.

The bookmark UI is rendered in a **closed Shadow DOM**. Page JavaScript receives `null` from the host element's `shadowRoot` and cannot traverse the rendered bookmark links.

## Behavior

- **Hover open:** move the pointer to the far-right page edge. Reveal starts immediately and passive hover does not move keyboard focus away from the webpage.
- **Motion:** the sidebar uses Helium's 200 ms side-chrome animation and easing.
- **Toolbar or shortcut open:** opens the panel and focuses/selects the search field.
- **Auto-hide:** starts after a 150 ms hover-exit grace period when unpinned. Leaving the browser window uses Helium's longer three-second grace period.
- **Pin:** the footer button keeps the sidebar open and persists across restarts.
- **Folders:** every bookmark folder is an independent top-level collapsible section. Collapse state is remembered by stable bookmark folder ID and synchronized across open webpages.
- **Search:** matches bookmark titles, URLs, folder titles, and folder paths. Search temporarily ignores stored collapse state.
- **Escape:** clears an active query first, then closes an unpinned sidebar.
- **Links:** normal click, Command/Ctrl-click, middle-click, and Shift-click retain native browser behavior outside edit mode.

## Edit mode

Select **Edit** in the footer to manage bookmarks directly from the sidebar. The button changes to **Done** while editing, and New Folder and Delete controls appear beside it.

- Folder and bookmark rows receive checkboxes.
- Folders and bookmarks cannot be selected at the same time.
- Selecting any item disables New Folder until the selection is cleared.
- Delete remains disabled until at least one item is selected.
- The browser-owned Bookmarks bar, Other bookmarks, and Mobile bookmarks roots cannot be deleted.
- New folders are created inside Other bookmarks and appear as top-level sidebar sections.
- Deleting bookmark sites always requires confirmation.
- Deleting folders requires choosing between:
  - **Delete folder only:** move its direct bookmarks and subfolders to Other bookmarks, then remove the empty folder.
  - **Delete everything:** remove the selected folders and every item contained inside them.

Folder and bookmark selection is temporary and is cleared when edit mode ends. Bookmark changes are pushed to every connected webpage after the browser confirms the mutation.

## Keyboard shortcut

The suggested default is:

- macOS: `Command+K`
- Windows/Linux: `Ctrl+K`

Some Chromium builds reserve this binding for the address bar. Configure or inspect the actual assignment at `helium://extensions/shortcuts` or `chrome://extensions/shortcuts`.

The badge inside the search field shows only the shortcut Chromium reports as actually assigned. If the binding is cleared or rejected because of a conflict, the badge stays hidden rather than claiming that the shortcut works.

## Favicons and privacy

Bookmarks use only Chromium's extension favicon endpoint:

```text
chrome-extension://<extension-id>/_favicon/?pageUrl=...&size=32
```

The extension does **not** request `/favicon.ico` from bookmarked websites and does not use a third-party favicon provider. If Chromium has no cached favicon for a bookmark, the existing letter avatar remains visible. This prevents rendering the sidebar from contacting every bookmarked domain.

## Live updates and extension reloads

On an ordinary new HTTP or HTTPS page, the content script connects automatically and the service worker immediately pushes the current bookmark tree. A normal page load should not require a manual refresh.

Bookmark changes are debounced and pushed to connected tabs over a long-lived port. The content script reconnects with capped exponential backoff when the Manifest V3 service worker is temporarily suspended.

Reloading or updating an unpacked extension is different. Chromium does not reinject the updated content scripts into tabs that were already open. Those tabs keep the old, permanently invalid runtime context, so they must be refreshed once after each extension reload. This is normal during development and is not required for every later page navigation.

The stale script treats an invalidated context as terminal, cancels reconnect timers, removes its old sidebar host, and does not repeatedly call invalid extension APIs.

## Browser limitations

The sidebar is injected only into top-level `http://` and `https://` pages. It does not appear on:

- `helium://`, `chrome://`, or `chrome-extension://` pages
- extension-management pages
- the Chrome Web Store
- browser-controlled new-tab pages
- iframes
- `view-source:`, `data:`, and `blob:` pages
- local `file://` pages unless the manifest is modified and file access is enabled

These restrictions are enforced by Chromium.

## Persistent state

Stored in `chrome.storage.local`:

| Key | Meaning |
|---|---|
| `heliumBmSidebar:collapsed:v1` | Per-folder collapsed state keyed by bookmark folder ID. Shared across all webpages in the browser profile. |
| `heliumBmSidebar:pinned:v1` | Whether the sidebar is pinned. |

Every open page listens to `chrome.storage.onChanged`, so a folder collapsed on one webpage is reflected on the others. Startup does not prune stored folder IDs until the first real bookmark tree has arrived. Only state for folders confirmed to be deleted is removed.

Search text, edit-mode selection, hover state, and selected bookmark rows are not persisted.

## Architecture

```text
helium-tweaks/
├── manifest.json
├── background.js
├── bookmark-editor.js
├── hover-controller.js
├── sidebar-fixes.js
├── content.js
├── sidebar.css
├── README.md
├── tools/
│   └── make-icons.py
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

`background.js` owns bookmark access, validates bookmark mutations, listens to bookmark events, reports the configured shortcut, and routes toolbar/command activation to tabs. `content.js` owns rendering and interaction inside the closed Shadow DOM. `bookmark-editor.js` adds the editing controls and sends mutation requests to the service worker. `hover-controller.js` provides a transform-independent hover state machine. `sidebar-fixes.js` contains narrowly scoped compatibility corrections for startup persistence, keyboard isolation, pin alignment, and flat folder presentation.

No polling, remote scripts, framework, build step, or third-party runtime dependency is used.

## Troubleshooting

- **`Extension context invalidated`:** refresh the affected webpage after reloading the unpacked extension. The old content script cannot be revived by Chromium.
- **Bookmarks are missing immediately after an extension reload:** refresh that already-open tab once. Newly opened or normally navigated HTTP/HTTPS pages should load bookmarks automatically.
- **A newly opened HTTP/HTTPS page still needs refreshing without a recent extension reload:** inspect the content-script and service-worker consoles. That is not expected behavior.
- **Sidebar does not appear:** confirm the page uses HTTP or HTTPS and refresh tabs that predate installation or reload.
- **Shortcut does not work:** assign a non-conflicting binding in the browser's extension-shortcuts page.
- **A favicon shows a letter:** Chromium does not have a cached favicon for that URL. The extension intentionally does not fetch the bookmarked site directly.
