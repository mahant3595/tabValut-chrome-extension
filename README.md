# TabVault

Smart tab groups, bookmark manager, tab library, duplicate finder and a full
Appearance Studio — as a Chrome **Manifest V3** extension. Local-first:
everything lives in `chrome.storage.local`, IndexedDB and Chrome's own
tab-group/bookmark stores. Nothing leaves your device.

TabVault **does not unload, discard or close tabs** — it only ever *saves* and
*lazily opens* them. Memory reclamation is left to Chrome (Memory Saver) or to
a dedicated unloader extension you may run.

## Install (unpacked)

1. Run `npm run icons` once (generates `assets/icon{16,48,128}.png`; no dependencies, pure Node).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this folder.
4. The popup handles quick actions; the **Dashboard** button opens the full UI
   (also available via right-click → Options).

## Features

- **Three storage options for selected tabs** — Chrome tab groups (native),
  Chrome bookmarks, and the independent **TabVault library** (collections with
  notes, tags, search, sort, import/export). **Saving never closes or removes
  the source tab.** Destructive actions always require confirmation.
- **Custom group logos & wallpapers** — PNG/JPG/WebP uploads (logos ≤ 2 MB,
  validated type + dimensions; **wallpapers have no size limit**), stored as
  blobs in **IndexedDB** (not Base64 in settings),
  plus built-in icons and square/rounded/circle shapes. SVG is deliberately not
  accepted (untrusted SVG can carry scripts); logos live in TabVault's own UI —
  Chrome's native group bar doesn't support images.
- **Duplicate finder** — a **collection duplicate bar** (choose a collection,
  click "Check duplicates") finds duplicates *inside that collection only*
  and asks before removing extra copies (one copy is always kept). A
  browser-wide scan across open tabs, groups, bookmarks and the library is
  shown separately; TabVault never closes tabs.
- **Appearance Studio** — six presets (Dark Neon, High Contrast, Transparent
  Glass, Minimal Light, Minimal Dark, Wallpaper), independent accent color,
  glow toggle (reduced-motion aware), glass/panel opacity, font scale, and a
  wallpaper system (built-in gallery, upload, solid color, fit/position/
  brightness/readability overlay).
- **Vault Browser (a real, self-contained browser)** — the Vault Browser
  window has a **real address bar**: type any URL and press Enter to open it
  *inside this window*. Sites that allow embedding load inline in the viewer;
  sites that refuse (chatgpt.com, google, …) are **automatically opened in a
  real history-free tab** and still listed in the window's **Session** panel,
  so everything stays under this one browser. Back/forward step through your
  session history. It also browses what is stored in the vault: pick a group
  or collection and click through its tabs. Nothing here is written to
  browser history (the iframe viewer never navigates the top frame; real-tab
  opens scrub their history entry).
- **Lazy vault windows** — "Open in Vault" (from Vault Browser, collections,
  the manager window, or the preview window) opens a **real browser window
  with lazy tabs**: only the FIRST tab loads; every other tab is a local
  **placeholder page**
  ([src/vault-browser/placeholder.html](src/vault-browser/placeholder.html))
  showing the real title/URL/favicon with ZERO network activity — it loads
  the moment you click the tab (the service worker navigates it on
  activation). If something else unloads that tab later (Chrome's Memory
  Saver, your own unloader extension), clicking it again reloads it the same
  way. "Open in Vault (lazy)" uses the same mechanism, so restoring a
  collection never mass-loads its tabs. **Opening saved tabs NEVER creates a
  Chrome tab group** — Chrome persistently saves any group it creates ("saved
  groups", synced to your Google account) and no extension API can undo that,
  so TabVault leaves nothing Chrome could persist. Group management stays an
  explicit, user-initiated action (the popup "Group" button, the Tab Groups
  dashboard).
- **Collection manager window** — "Open (manager window)" on any collection
  opens a medium-size popup listing all its tabs with checkboxes: select one
  or many and **Save to…** (copy into another collection/folder) or **Send
  to…** (move them), open the selection history-free, or open it as a lazy
  vault window.
- **Vault-only bookmark folders** — bookmark folders that live *only* inside
  TabVault and are never written to Chrome's bookmark store (Bookmarks view →
  "Vault folders"). Chrome bookmarks are still fully managed alongside them.
- **Save many tabs** — multi-select any number of open tabs at once and store
  them into a collection, a new/existing vault folder, Chrome bookmarks, or a
  tab group (popup → "Save many…"). Saving never closes tabs.
- **Folder backup** — link a folder on your computer once (Dashboard →
  "Folder backup") and every collection, bookmark or tab-group change is
  mirrored there as plain files that **survive extension removal**. You pick
  the format on that page: **Readable Markdown** (default — open in any text
  editor, one section per collection or tab group, every tab a clickable
  link: `TabVault-library.md`, `TabVault-tab-groups.md`), **JSON**
  (`TabVault-library.json` re-imports into a fresh TabVault install with one
  click; `TabVault-tab-groups.json`), or **Both**. All formats also write
  `TabVault-bookmarks.html` (one Netscape file any browser can import) and
  `TabVault-README.txt` explaining what is here. Sync is automatic from the
  service worker on every change — including tabs **dragged into or out of a
  tab group**, which surface as tab-membership events (not tabGroups events)
  — plus a manual "Sync now". Unchanged files are not rewritten, and
  switching format removes the old format's files (only TabVault's own files
  — nothing else in the folder is ever touched).
  After a Chrome restart the page asks you to re-allow folder access once (a
  File System Access restriction — permission resets to "prompt"). Nothing is
  uploaded anywhere; files are written straight to disk, and unlinking never
  deletes them.

## Development

```sh
npm run check      # syntax, manifest integrity, project invariants
npm run selftest   # unit tests (settings normalization, urls, export)
npm run simulate   # simulation harness: real lazy-window core vs mocked chrome.*
npm run verify     # all three, in order
```

Zero runtime and zero dev dependencies — plain ES modules and `node:test`.

### Architecture

```
manifest.json
src/
  lib/            pure modules shared by the worker, popup, dashboard, tests
    settings.js   defaults + defensive normalization (never trust storage)
    urls.js       URL normalization + duplicate clustering
    export.js     collection backup format v1 + validated import
    folder-sync.js  linked-folder backup: plain-file mirror that outlives the
                    extension (handle persisted in IndexedDB, injected deps)
    images.js     upload validation (type/size/dimensions), logo refs
    idb.js        tiny IndexedDB blob store for logos/wallpapers
    themes.js     theme presets, wallpaper gallery, runtime CSS application
  background/
    vault-window-core.js  lazy vault window: first tab loads, the rest are
                          zero-network placeholders; chrome.* injected (testable)
    service-worker.js     message router, collections CRUD, settings, events
  popup/          quick actions (save, group, bookmark)
  dashboard/      full UI: collections, bookmarks, groups, duplicates,
                  Vault Browser, Appearance Studio
  vault-browser/  embedded shell + the lazy-tab placeholder page
  collection-window/  manager window (select tabs, Save to… / Send to…)
tools/
  simulate.mjs    mocked chrome.*; 11 scenarios / 56 checks (lazy core + folder backup)
  check.mjs       static checks (incl. "no tabs.remove", "no setInterval")
  make-icons.mjs  dependency-free PNG encoder
test/             unit tests (node --test)
```

The lazy-window core (`src/background/vault-window-core.js`) never touches
`chrome.*` directly: the tab/window/group/storage surfaces are injected, so
the exact production code runs inside the simulation harness.
`tools/simulate.mjs` covers lazy open, zero-network-before-entry, activation
navigation, deliberate-navigation respect, discard-then-reenter, placeholder
metadata, explicit load, cleanup, validation and the never-close guarantee.

## Chrome API facts this codebase encodes

- `chrome.tabs.create({ url })` on a **local extension page** performs no
  network activity — that is what makes zero-cost lazy tabs possible.
- There is no API to create a tab that is truly "unloaded but titled";
  TabVault's placeholder page fakes the title/URL/favicon locally instead.
- `tab.discarded` is ground truth for whether a tab's page is in memory.
- Opening/expanding a tab group makes Chrome load all its tabs natively; an
  extension cannot prevent that — which is exactly why TabVault's lazy flow
  creates placeholders directly rather than relying on collapsed groups.
- Tabs with an `openerTabId` were opened deliberately (middle-click /
  `target=_blank`) — never touch those.
- `tab.groupId` is readable with the plain `tabs` permission (`-1` = ungrouped).

## Invariants (enforced by `npm run check`)

- **No `tabs.remove` anywhere** — TabVault never closes tabs.
- **No `tabs.discard` anywhere** — TabVault never unloads tabs either; that is
  the job of Chrome or the user's own unloader extension.
- **No `setInterval`, no `eval`/`new Function`, no long-lived `setTimeout`s** —
  event-driven only.
- No remote code; all UI is bundled extension pages.

## Known limitations

- History-free opening is best-effort: Chrome has no API to navigate a tab
  without recording a visit at all, so "Open (no history)" deletes the entry
  right after the page loads (including the redirected URL). Viewing inside
  the Vault window's embedded viewer never touches history, but many sites
  refuse embedding (X-Frame-Options / CSP) and must use the history-free tab
  path.
- Placeholder tabs carry the title/favicon as of when they were saved; the
  live title appears only after the tab is first loaded.
- An extension popup cannot be transparent over the desktop; glass effects are
  rendered within the extension's own surfaces only.
- Chrome's native tab-group bar cannot display custom logos; TabVault shows
  them on its own cards, lists and headers.
- Expanding or restoring a tab group in Chrome natively loads all its tabs —
  no extension can veto that. TabVault's lazy mechanism only applies to
  windows it creates itself ("Open in Vault", "Restore as tab group (lazy)").
- Chrome can natively SAVE any tab group it creates ("saved groups", synced
  to the Google account) and exposes no API to detect, prevent or undo that.
  TabVault's "Open in Vault" therefore creates **no tab group at all** unless
  you explicitly choose "Restore as tab group (lazy)"; only then does Chrome
  have something it can persist.
- Folder backup needs File System Access, whose permission normally resets to
  "prompt" when Chrome restarts. The linked folder is remembered, but you
  must open Dashboard → Folder backup and click "Sync now" (one gesture) after
  each restart before automatic sync works again; changes made meanwhile are
  queued (`backupPending`) and written at that point. The service worker
  cannot request the permission itself (no user gesture in a worker).
