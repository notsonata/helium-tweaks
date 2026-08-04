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

No `host_permissions`, no `<all_urls>` host access, no remote code. The content
script is statically declared in the manifest (no dynamic injection).

---

## Using it

- **Open:** pointer to the right screen edge, or press the toolbar button, or
  press the keyboard shortcut.
- **Auto-hide:** 140 ms after the pointer leaves the panel (only when
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

- **Default:** `Command+Shift+K` (macOS) / `Ctrl+Shift+K` (Windows/Linux).
- Opens the sidebar and focuses the search field.
- **Change it:** open `helium://extensions/shortcuts` (or
  `chrome://extensions/shortcuts`) → find "Helium Bookmarks Sidebar" → edit the
  "Open the bookmarks sidebar and focus search" binding.
- The actual configured shortcut is read at runtime and shown in the search
  field's badge, so the badge always reflects your real binding.

`Command+K` / `Ctrl+K` is deliberately **not** used, because Helium (like
Chrome) reserves it for the address bar and the extension can't reliably
override it. `Shift+K` avoids that conflict.

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
script renders into a closed-off Shadow DOM. No polling. Bookmark change events
(`onCreated`, `onRemoved`, `onChanged`, `onMoved`, `onChildrenReordered`,
`onImportEnded`) are debounced (~90 ms) before re-fetching and re-rendering, so
a large import won't flood the sidebar.

**Isolation:** one host element (`#helium-bookmarks-sidebar-root`) with one
Shadow DOM root. Page CSS cannot style the sidebar and sidebar CSS cannot leak
into the page. A duplicate-injection guard guarantees only one sidebar per page.

**Favicons:** `chrome.runtime.getURL("/_favicon/")` with `pageUrl` and
`size=32`. A letter-avatar fallback shows while loading or when no favicon is
available. No external favicon provider is used.

---

## Regenerating the icons

The icons are generated from the template palette with the Python standard
library only (no Pillow/external dependencies):

```sh
python3 tools/make-icons.py
```

This overwrites `icons/icon-{16,32,48,128}.png`. Run it again if you want to
tweak the glyph in `tools/make-icons.py`.

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
  `Ctrl/⌘+Shift+K`. Reassign it at `helium://extensions/shortcuts`.
