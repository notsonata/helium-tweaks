# Helium Bookmarks Sidebar

A right-edge bookmark sidebar overlay for the **Helium browser** (and other
Chromium-based browsers). It slides in when your pointer reaches the right edge
of a page, shows your real browser bookmarks as collapsible folders, and uses
Chromium's built-in favicon service — no external requests.

It is **not** built on Chromium's native Side Panel API. The sidebar is injected
as a Shadow-DOM-isolated webpage overlay, so it works the same way on any
ordinary web page.

> Visual design is matched 1:1 to the `helium-bookmarks-sidebar-210-v10.html`
> prototype (210 px panel width, exact palette, typography, radii, and timings).

---

## Load it (Helium / Chromium, unpacked)

1. Open the extensions page:
   - **Helium:** `helium://extensions`
   - **Chrome/Chromium:** `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `helium-bookmarks-sidebar/` folder (the one containing
   `manifest.json`).
5. Open any normal `http(s)` webpage. Move your pointer to the **far-right edge
   of the screen** — the sidebar slides in.

The toolbar action button (and the keyboard shortcut below) also open the
sidebar and focus the search field.

---

## Permissions

Only three permissions are requested, all required for core functionality:

| Permission | Why it's needed |
|---|---|
| `bookmarks` | Read your bookmark tree and subscribe to live changes so the sidebar stays in sync. |
| `storage` | Persist per-folder collapsed state and the pinned/unpinned state across restarts. |
| `favicon` | Use Chromium's built-in `_favicon` endpoint for bookmark icons instead of an external service. |

The extension does not declare a separate `host_permissions` key, but its
content script runs on **all HTTP and HTTPS pages** (`matches: ["http://*/*",
"https://*/*"]`) because edge-hover activation must be available on those pages.
Chrome may surface this as site-access information on the extension card. There
is no `<all_urls>` host access and no remote code; the content script is
statically declared in the manifest (no dynamic injection).

The sidebar is rendered inside a **closed** Shadow DOM, so page JavaScript
cannot read the bookmark titles/URLs shown in the sidebar via the host
element's `shadowRoot` (which is `null` in closed mode).

---

## Using it

- **Open:** pointer to the right screen edge (opens after a short delay that
  mirrors the close delay, so it feels as responsive to open as to close), or
  press the toolbar button, or press the keyboard shortcut.
- **Auto-hide:** ~140 ms after the pointer leaves the panel (only when
  unpinned).
- **Pin:** click the pin button in the footer to keep the sidebar open
  permanently (persists across pages/restarts).
- **Collapse a folder:** click its header. Collapsed state is remembered per
  folder.
- **Search:** type in the search field. Matches bookmark **titles**, **URLs**,
  **folder titles**, and **folder paths**. Stored collapsed states are ignored
  during search and restored when cleared.
- **`Esc`:** if search has text, the first `Esc` clears it; otherwise `Esc`
  closes the sidebar (when unpinned).
- **Bookmarks:** click to open in the current tab, **⌘/Ctrl-click** or
  **middle-click** for a new tab — native link behavior is preserved.

---

## Keyboard shortcut

- **Default:** `Command+K` (macOS) / `Ctrl+K` (Windows/Linux).
- Opens the sidebar and focuses the search field.
- While the sidebar is open, `Command+K` / `Ctrl+K` refocuses search (it's
  captured by the sidebar so it doesn't reach the page).
- **Change it:** open `helium://extensions/shortcuts` (or
  `chrome://extensions/shortcuts`) → find "Helium Bookmarks Sidebar" → edit the
  "Open the bookmarks sidebar and focus search" binding.
- The actual configured shortcut is read at runtime and shown in the search
  field's badge, so the badge always reflects your real binding (it falls back
  to the `Command+K` / `Ctrl+K` default if the binding is cleared or conflicts).

> **Note:** some browsers reserve `Command+K` / `Ctrl+K` for the address bar.
> The extension command takes precedence when available, but if your browser
> intercepts it first, reassign the shortcut at the URL above — the badge will
> update to show whatever you set.

---

## Browser-page limitations (read this)

The sidebar is injected only into **top-level `http://` and `https://` pages**.
It will **not** appear on:

- `chrome://` and `chrome-extension://` pages
- `helium://` internal pages
- the Extensions manager (`helium://extensions`)
- the Chrome Web Store
- the New Tab Page and other browser-controlled pages
- **any iframe** (top-level frame only)
- `file://` pages (by default — see below)
- `view-source:`, `data:`, `blob:` pages

This is a hard Chromium restriction: extensions cannot inject content scripts
into browser-protected pages. The toolbar button and keyboard shortcut will do
nothing on those pages.

### Optional: enable `file://` pages

By default the manifest matches only `http(s)`, so local files won't get the
sidebar. To support them:

1. In `manifest.json`, under `content_scripts[0].matches`, add:
   ```json
   "file:///*"
   ```
2. Reload the extension.
3. On the extensions page (`helium://extensions`), open the extension's
   **Details** and enable **"Allow access to file URLs"**.

---

## Persistent state

Stored in `chrome.storage.local`, namespaced:

| Key | Type | Meaning |
|---|---|---|
| `heliumBmSidebar:collapsed:v1` | `{ [folderId]: boolean }` | Collapsed state per bookmark folder, keyed by the folder's stable bookmark id. |
| `heliumBmSidebar:pinned:v1` | `boolean` | Whether the sidebar is pinned open. Defaults to `false` on first run. |

Not persisted (intentionally): the search query, selected row, hover state.
Deleted folders are pruned from the collapsed map on the next render.

---

## Architecture

```
helium-bookmarks-sidebar/
├── manifest.json       MV3 manifest (permissions, content script, action, command)
├── background.js       Service worker: bookmark data + live events + port bridge
├── content.js          Injected overlay: Shadow DOM sidebar + interaction
├── sidebar.css         Template styles, scoped to :host (Shadow DOM)
├── README.md           This file
├── tools/
│   └── make-icons.py   stdlib-only PNG generator (zlib+struct), run once
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

**Data flow:** `chrome.bookmarks` → service worker → long-lived port → content
script renders into a **closed** Shadow DOM. No polling. Bookmark change events
(`onCreated`, `onRemoved`, `onChanged`, `onMoved`, `onChildrenReordered`,
`onImportEnded`) are debounced (~90 ms) before re-fetching and re-rendering, so
a large import won't flood the sidebar.

**Isolation:** one host element (`#helium-bookmarks-sidebar-root`) with one
Shadow DOM root. Page CSS cannot style the sidebar and sidebar CSS cannot leak
into the page. A duplicate-injection guard guarantees only one sidebar per page.

**Favicons:** each bookmark tries Chromium's `chrome.runtime.getURL("/_favicon/")`
endpoint first (cached, privacy-preserving, works offline). If that has no icon
for a site, it falls back to the site's own `/favicon.ico`. If both fail, a
letter-avatar derived from the bookmark title is shown. No third-party favicon
provider is used.

---

## Icons

The extension toolbar icons (`icons/icon-{16,32,48,128}.png`) are the project's
brand mark — a blue rounded square with a white `*t` glyph. The 16/32 px sizes
are copied directly from `favicons/favicon-{16,32}x32.png`; the 48 px and 128 px
sizes are downsampled from `favicons/android-chrome-{192,512}x{192,512}.png` at
clean 4:1 ratios.

The full brand favicon set (192/512 px, apple-touch-icon, `.ico`,
`site.webmanifest`) is preserved under `favicons/`.

A fallback generator is also included (`tools/make-icons.py`, Python stdlib
only — no Pillow) that draws a simpler bookmark-ribbon glyph in the template
palette. Only run it if you want to revert to the generated icons:

```sh
python3 tools/make-icons.py   # overwrites icons/icon-{16,32,48,128}.png
```

---

## Troubleshooting

- **Sidebar doesn't appear:** confirm the page is `http(s)`, not a protected
  page (see limitations). After loading the extension, refresh already-open
  tabs once — content scripts don't retroactively inject into tabs that were
  open before installation.
- **Sidebar vanished after reloading the extension:** the old content script's
  connection is invalidated. Refresh the page once to reconnect. (This is
  expected MV3 behavior.)
- **Bookmarks look empty:** open the bookmarks manager (`helium://bookmarks`)
  and confirm you have bookmarks in the bar / other bookmarks. Newly added
  bookmarks appear live without a page refresh.
- **Shortcut doesn't work:** another extension or the browser may have claimed
  `Ctrl/⌘+K`. Reassign it at `helium://extensions/shortcuts`.
