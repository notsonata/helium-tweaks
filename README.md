# Helium Bookmarks Sidebar

A right-edge bookmark sidebar overlay for the **Helium browser** and other Chromium-based browsers. It opens when the pointer reaches the right edge of a normal webpage, displays real browser bookmarks as collapsible folder sections, and can remain pinned.

The extension does not use Chromium's native Side Panel API. It renders an overlay inside a closed Shadow DOM so webpage styles cannot affect it and page scripts cannot read the bookmark titles or URLs rendered inside it.

The visual design follows the `helium-bookmarks-sidebar-210-v10.html` prototype, including the 210 px panel, compact rows, overflow fade, colors, typography, radii, and timing.

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
| `bookmarks` | Read the bookmark tree and subscribe to bookmark changes. |
| `storage` | Persist collapsed folders and pinned state. |
| `favicon` | Use Chromium's private `_favicon` endpoint. |

The extension does not declare a separate `host_permissions` key, but its content script runs on all HTTP and HTTPS pages because edge-hover activation must be available on those pages. Chromium may display this as site access.

The bookmark UI is rendered in a **closed Shadow DOM**. Page JavaScript receives `null` from the host element's `shadowRoot` and cannot traverse the rendered bookmark links.

## Behavior

- **Hover open:** move the pointer to the far-right page edge. Passive hover does not move keyboard focus away from the webpage.
- **Toolbar or shortcut open:** opens the panel and focuses/selects the search field.
- **Auto-hide:** closes about 140 ms after the pointer leaves when unpinned.
- **Pin:** the footer button keeps the sidebar open and persists across restarts.
- **Folders:** every folder is a collapsible section. Nested folders are nested sections. Collapse state is remembered by bookmark folder ID.
- **Search:** matches bookmark titles, URLs, folder titles, and folder paths. Search temporarily ignores stored collapse state.
- **Escape:** clears an active query first, then closes an unpinned sidebar.
- **Links:** normal click, Command/Ctrl-click, middle-click, and Shift-click retain native browser behavior.

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

Bookmark events are debounced and pushed from the Manifest V3 service worker to connected tabs over a long-lived port. The content script reconnects with capped exponential backoff when the service worker is temporarily suspended.

Reloading an unpacked extension is different: content scripts already present in open tabs retain a permanently invalid runtime context. The stale script now treats that condition as terminal, cancels reconnect timers, removes its old sidebar host, and does not repeatedly call invalidated extension APIs. Refresh the page once to inject the newly loaded extension version.

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
| `heliumBmSidebar:collapsed:v1` | Per-folder collapsed state keyed by bookmark folder ID. |
| `heliumBmSidebar:pinned:v1` | Whether the sidebar is pinned. |

Search text, hover state, and selected bookmark rows are not persisted. State for deleted folders is pruned during a normal render.

## Architecture

```text
helium-tweaks/
├── manifest.json
├── background.js
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

`background.js` owns bookmark access, listens to bookmark events, reports the configured shortcut, and routes toolbar/command activation to tabs. `content.js` owns rendering and interaction inside the closed Shadow DOM. No polling, remote scripts, framework, build step, or third-party runtime dependency is used.

## Troubleshooting

- **`Extension context invalidated`:** refresh the affected webpage after reloading the unpacked extension. The old content script cannot be revived by Chromium.
- **Sidebar does not appear:** confirm the page uses HTTP or HTTPS and refresh tabs that predate installation or reload.
- **Shortcut does not work:** assign a non-conflicting binding in the browser's extension-shortcuts page.
- **A favicon shows a letter:** Chromium does not have a cached favicon for that URL. The extension intentionally does not fetch the bookmarked site directly.
