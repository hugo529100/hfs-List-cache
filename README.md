# List-cache

List-cache is a listing cache plugin for [HFS](https://github.com/rejetto/hfs). It captures the complete file listing of large folders ahead of time, splits it into page packets, and serves those packets on later visits instead of making HFS scan the whole directory again.

Typical use cases:

- Music, photo, backup, and offline-website folders with thousands of files
- Folders where directory scanning makes the first page slow
- Keeping HFS-native sorting, comments, Fixed-folder-order, and Hide-file behavior on a frozen listing

Current plugin version: **6.0**  
Storage layout version: **2.6**  
Requirements: HFS **3.4.1** (plugin API 12.3) or a compatible version

---

## Features

- Automatically freezes folders above the configured threshold
- Splits the frozen listing into pages for fast first-page loading
- One freeze threshold; every frozen folder uses the same mode
- Complete listing loaded into native `HFS.state.list`; HFS native pager, sorting, filter, and file-show
- File operations and comments never rebuild automatically; the header breathes until the user runs Folder menu > Rebuild Frolist
- Fixed-folder-order remains the highest-priority sort over the complete list
- HFS native search UI is preserved
- Hide-file rules are applied when the frozen listing is created; a rule change triggers a rebuild
- Folder menu > Rebuild Frolist (or double-click / double-tap the header status) forces a rebuild

---

## Installation

1. Copy the entire `List-cache` folder into the HFS plugin directory, for example:

   ```text
   HFS3/plugins/List-cache/
   ```

2. Enable **List-cache** in the HFS plugins/Options UI.
3. Reload the page.

There is no separate master switch inside the plugin. **Enabling the plugin in HFS is enough.**

The first visit to a folder above the threshold still lets HFS produce the listing; the plugin builds the frozen copy alongside it, so that visit can be slow. Later visits use the frozen listing.

> The page size comes from `page_size` in HFS `config.yaml`, not from a plugin-specific option. After changing `page_size`, restart HFS. The frozen database is cleared and rebuilt with the new page size.

---

## Single freeze threshold

| Folder entry count | Behavior |
|---|---|
| `<= minEntries` (default 200) | Not frozen; HFS native listing |
| `> minEntries` | One complete frozen listing; HFS native pager, sorting, filter, and file-show |

The threshold is a strict "greater than" comparison: 200 entries is not frozen; 201 starts freezing. Every frozen folder uses the same complete native-list mode. There is no second lazy tier and no size-dependent validity.

---

## Frozen folders: the complete listing in HFS

1. Opening the folder returns one complete frozen listing from the backend.
2. The browser keeps that complete list in `HFS.state.list`, exactly as if HFS had scanned the folder.
3. HFS uses its normal page size, native pager, native sorting, and native file-show dialog on top of that list.
4. List-cache only supplies/caches the listing data; it does not create a second page-aware list for the UI.
5. Thousands of DOM rows are never rendered at once because HFS still renders one page.

### Page-session snapshot

While the document stays open, the plugin keeps the listing it already loaded:

- `lc_all` is cached in memory for the lifetime of the page, so Musicplayer+ and other consumers always receive the same snapshot.
- `lc_meta` is cached for the same page session.
- HFS `reloadList()` may replace `state.list`; the plugin restores the complete ordered listing.
- File operations and comment edits do **not** invalidate or rebuild the frozen backend.
- A delete or upload updates only the page-session `lc_all` copy and the visible page list; the frozen database is untouched.
- This keeps the page/playlist count in sync immediately after a delete without rebuilding.
- A comment still updates its row text immediately, but Fixed tag reordering waits for the explicit rebuild/page reload.
- Nothing is rebuilt in the background behind the player; the header breathes until the user runs Folder menu > Rebuild Frolist.
- A hidden leftover `.file-show` no longer keeps the page in page-slice mode; the complete list is restored as soon as the dialog is actually invisible.

### Sorting

The first tier supports the full HFS sort state:

- `name`
- `extension`
- `size`
- `time`
- `creation`
- `invert_order`
- `folders_first`
- `sort_numerics`

Sorting uses HFS's native controls over the complete list, not just the current page.

### Fixed-folder-order second list

Fixed-folder-order does not run an ad-hoc comparison on every page. The first tier builds a separate second list:

1. Start from the native order under the current HFS sort settings (the base).
2. Apply Fixed's `sortCompare` as the highest-priority sort.
3. When Fixed considers two entries equal, keep their original base order instead of re-sorting them by name.

As a result:

- Files with comment tags move to their Fixed positions, following the configured `commentOrder` (for example `top` -> `3` -> `2` -> `1`).
- Untagged files keep the existing local list order.
- Fixed comment tags, file patterns, and folder patterns remain the highest priority.
- When Fixed is disabled, the native sorted list is used directly.

Comment text is updated in place. The new Fixed tag order is applied on the next real page load, not in the current player session. Sort changes rebuild the corresponding caches.

### Fixed plugin configuration

For comment tags to take effect:

1. Enable **Fixed-folder-order** in HFS.
2. Enable **Enable Custom Sorting** in its Options dialog.
3. Configure `commentOrder`, for example:

   ```yaml
   top
   3
   2
   1
   ```

4. Keep `commentOrderEnabled: true` (the default).

List-cache does not duplicate Fixed's configuration. It calls the HFS `sortCompare` event in the browser.

### Videos-player

Videos-player builds its playlist from the complete ordered `lc_all` listing, including the Fixed-folder-order comment-tag overlay. When List-cache removes a deleted file from the page-session list, Videos-player 5.0 applies that updated list immediately, so the playlist count decreases and the deleted row disappears without a backend rebuild. The frozen database itself is only replaced by the manual double-click rebuild.

Videos-player does not intercept HFS's file-show menu or Delete API. HFS keeps its normal Delete flow and native confirmation. While the player playlist is open, Videos-player only:

- closes a stale `.file-menu` when the HFS delete confirmation appears
- treats a second Delete as confirmation of that HFS delete dialog

Hotkey is not modified. When the last playlist item ends naturally, playback wraps to the first item and the playlist scrolls back to the top. A manual double-click rebuild is what makes the change permanent in the frozen database; the current page/player use the session copy.

### FileShow / image browsing

In the first tier, `HFS.state.list` contains the complete frozen listing. HFS FileShow therefore navigates every file exactly like a native folder. Before opening the dialog, List-cache also places the complete ordered list in place so HFS's own Delete/next selection follows the visible order.

### Header status

Frozen mode shows one line at the bottom of the header:

```text
Frozen list mode | FRO:11-25 / EXP:12-26 | 3,485 items / size: 98.4 MB
```

- On wide screens, when there is enough room on the right, it shares the bottom row with the breadcrumb buttons.
- On narrow screens or with a long path, it automatically returns to its own line.
- Width measurement uses a canvas and a hysteresis margin, so breadcrumb hover cannot flip the layout back and forth.
- The native `#folder-stats` label is hidden to avoid two count modules.
- When a change is detected, the line changes to `Changes detected - Folder menu > Rebuild Frolist or double click` and breathes through a JavaScript opacity animation. The dirty marker is stored server-side, so every browser sees it.
- The current folder's breadcrumb menu always gets a **Rebuild Frolist** item directly above **Reload** on a frozen folder, whether or not that folder is dirty. Double-clicking (or double-tapping) the status line remains a shortcut.

---

## Search and filtering

### Search

- Frozen folders use native HFS search against the current folder/disk.
- Comment search always uses native HFS search, because comments may change after the freeze.
- The search dialog can explicitly request HFS native recursive search (`lcNative`).

### Filtering

The complete frozen list is in `HFS.state.list`, so the native HFS filter and paging operate over the whole listing.

---

## Comments

Comments come from `descript.ion` in the folder.

- Every page and complete listing overlays the current `descript.ion` comments.
- Editing a comment does not rebuild the frozen listing. The row text updates immediately and the folder is flagged dirty.
- Fixed tag reordering waits for the explicit rebuild.
- File adds/deletes/renames are not simulated in the frozen snapshot; the flag tells the user to rebuild when ready.
- External `descript.ion` edits require a page reload.
- Comment search always uses native HFS search.

---

## Hide-file

Hide-file is a frontend plugin. If a frozen listing bypassed it, hidden files would reappear. List-cache handles this as follows:

- Hide-file rules are applied while the frozen listing is created.
- A signature of the rules is stored in `meta.json`.
- The signature is compared on later visits; when the rules change, the frozen listing is treated as stale and rebuilt.
- Changes to hide rules or the enabled plugin list change the signature.

---

## Settings

| Setting | Default | Description |
|---|---:|---|
| Freeze folders with more entries than | 200 | Freeze only folders above this count; one mode for all frozen folders |
| Valid for | 31 days | Validity of a frozen listing |
| Debug log | off | Writes debug output to the plugin log and `storage/debug.log` |

### Page size

The page size is not configured in the plugin panel. It is read from `page_size` in HFS `config.yaml`.

- The plugin reads the current `page_size` at startup.
- `settings.json` records the page size used to build the database.
- If the page size changes, the plugin clears the entire frozen database to avoid mixing packets with different page sizes.
- Restart HFS after changing it.

---

## Rebuild and validity

A frozen listing is considered stale when:

1. Its 31-day validity period has expired.
2. The folder entry count is no longer greater than `minEntries`.
3. The Hide-file signature changed.
4. The storage layout version (`VERSION_TAG`) changed.
5. The HFS `page_size` changed (the whole database is cleared at startup).

File operations and comments do **not** make the listing stale. They only set the persistent dirty flag and breathe the header status. Rebuild explicitly with a double-click when convenient.

A stale listing is rebuilt on the next listing request. The user-triggered rebuild marks it invalid, reloads the native listing, waits for the new `updatedAt`, then reloads the page.

> After raising `minEntries`, old frozen databases for small folders are no longer used. The next visit goes through the HFS native listing and removes the old record.

---

## Storage layout

All data is inside the plugin storage directory:

```text
storage/
  settings.json                 pageSize used for the database
  folders.json                  uri -> { dir, count, updatedAt }
  version.json                  storage layout version
  invalid/                      per-folder rebuild markers written by lc_invalidate
  dirty/                        per-folder "changed since freeze" markers, shared by all browsers
  debug.log                     created only when debug is enabled
  lists/
    <slug>-<hash>/
      <gen>/
        meta.json               format, uri, count, pageSize, updatedAt, gen, chunks, accounts
        c0000.json              one page, format: [["+", entry], ...]
        c0001.json
        ...
```

Entry fields:

- `n`: name; folder names end with `/`
- `c`: creation time in ISO format
- `m`: modification time in ISO format
- `s`: size
- Comments may be written into a packet at build time, but every read overlays the current `descript.ion`; comment edits therefore do not require a rebuild

### Version rules

- `exports.version` is the plugin information version and **never** clears the frozen database.
- `VERSION_TAG` is the storage layout version. It should change only when the meta/chunk format changes; changing it clears all frozen databases.
- Do not raise `VERSION_TAG` for CSS, sorting, header, or other frontend-only changes.

---

## Permissions and security

- A frozen listing is only a cache of a listing HFS has already produced. **HFS still decides who may open the folder.**
- `meta.json` records the accounts that HFS has already served that folder to.
- Only recorded accounts can read the frozen listing. Other accounts still go through the normal HFS flow and are recorded after HFS responds.
- The root folder `/` is never frozen.
- Hide-file is applied when the listing is created so the cache cannot bypass hidden-file rules.
- Comment overlays read the source directory within the HFS directory scope.
- The plugin does not change HFS authentication, permissions, or password logic.

---

## Internal endpoints

Used by the frontend and for debugging. HFS adds an underscore prefix:

| Name | Purpose |
|---|---|
| `lc_meta` | Returns frozen status, entry count, page size, validity, and first-tier flag |
| `lc_page` | Reads one frozen page |
| `lc_all` | Reads the complete frozen listing used as the native first-tier list |
| `lc_comment` | Reads/refreshes comment data |
| `lc_dirty` | Persists the "changed since freeze" marker shared by all browsers |
| `lc_invalidate` | Marks a frozen listing invalid for the manual rebuild |

The backend also hooks the HFS `get_file_list` request to intercept normal listing requests.

---

## File structure

```text
List-cache/
  plugin.js              Backend: capture, packet writing, index, validity, Hide-file, comments, API
  public/main.js         Frontend: tier entry, native first-tier list integration, Fixed second list, search UI
  public/style.css       Header status, pager, native statistics hiding, narrow-screen layout
  README.md              This file
```

There is no build step. HFS hot-reloads `plugin.js`; after changing `public/*`, press **Ctrl+F5** to bypass the browser cache.

---

## FAQ

### The first visit is still slow

The first visit lets HFS scan the directory and build the frozen copy. It becomes fast on later visits.

### A folder is not frozen

- The entry count does not exceed `minEntries` (200 by default).
- The folder is the root `/`.
- The current account has not yet been served that folder by HFS.
- The folder is currently being built.

### I deleted a file and refreshed before rebuilding

The delete updates the current session immediately, but a full page refresh falls back to the frozen database, which still contains the deleted entry. The header breathes the rebuild prompt; use Folder menu > Rebuild Frolist to make the deletion permanent. This is the trade-off for never rebuilding while the player is running.

### Sorting controls are disabled

There is no lazy second tier now. If sorting controls are disabled, check that the folder is not open in an older cached page; force-refresh the browser.

### Fixed order does not take effect

Check:

1. Fixed-folder-order is enabled in HFS.
2. **Enable Custom Sorting** is enabled in its Options dialog.
3. `commentOrderEnabled` is true.
4. The files really have `descript.ion` comments.
5. Rebuild the frozen listing after adding or editing comments.

### The order does not change after editing a comment

- Comment changed through the HFS UI: the row text updates immediately; the new Fixed tag order is applied on the next page load.
- `descript.ion` edited directly: reload the page.
- Comment search uses native HFS search and does not use the frozen listing.

### All caches disappeared after changing page_size

This is expected. Packets built with different page sizes cannot be mixed, so the plugin clears the frozen database at startup.

### Force a full rebuild

Stop HFS, then delete:

```text
plugins/List-cache/storage/lists/
plugins/List-cache/storage/folders.json
```

Start HFS again. `version.json` and `settings.json` may be kept. Deleting `version.json` also triggers a database clear.

### Two entry-count modules appear in the header

The native statistics label is hidden in frozen mode. If it is still visible, force-refresh CSS/JS with Ctrl+F5.

---

## Known limitations

- The first tier keeps the complete listing in memory up to `localSortUpTo` (5,000 by default).
- Every frozen folder keeps the complete listing in memory; very large folders use more memory.
- File/comment edits update the frozen copy only after the manual rebuild.
- Comments are read from `descript.ion`; external edits require a page reload.
- Fixed comment-tag ordering appears after the manual rebuild.
- Extremely large directories above 3,000,000 entries hit the capture safety limit.

---

## Development notes

- Backend entry point: `exports.init(api)` in `plugin.js`
- Frontend entry points: `public/main.js`, `public/style.css`
- Storage layout constants: `FORMAT`, `VERSION_TAG`
- Freeze decision: `meta.count > threshold()`
- Native list ordering: `localPureOrder()` and `localOrderForCurrentSort()` in `public/main.js`
- Fixed overlay: the stable sort inside `localOrderForCurrentSort()`
- Syntax check after changes:

  ```bash
  node --check plugin.js
  node --check public/main.js
  ```

- Do not raise `VERSION_TAG` for frontend-only changes; doing so clears and rebuilds every frozen database.

---

## Version history

### 6.0

- Fixed a `HFS.state.list` identity loop: the complete list was rewritten even when its contents were unchanged
- The list watcher and full-list assertion now compare entry URIs and only write on a real difference
- Prevents Frontend-toggles from re-ordering the menu bar hundreds of times during hover, which caused flicker and missed clicks
- Restored the shared header row while keeping canvas measurement and hysteresis

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.9

- Restored the shared header row from 5.7
- Removed the hidden clone used for width measurement; width now comes from canvas text measurement, so no DOM is added/removed during hover
- Added layout hysteresis so a small breadcrumb hover width change cannot toggle the shared row back and forth
- This removes the body MutationObserver feedback loop that made the menu-bar search button flicker and become sluggish

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.8

- Removed the header `lc-header-share` measurement/toggle loop
- The frozen status now always stays on its own header line, so hovering the last breadcrumb no longer causes width feedback, flashing, or layout oscillation
- Removed the unused share-layout CSS

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.7

- Removed the date-based `regenerateBefore` cutoff, which could make every older frozen folder rebuild again hours later
- A capture that unexpectedly returns a small/short list no longer deletes the existing frozen copy
- On startup, index entries whose frozen directory/meta is missing are removed instead of being reported as frozen
- This prevents the same missing copy from repeatedly producing a rebuild state

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.6

- A dirty marker older than the current frozen `updatedAt` is now treated as stale and removed automatically
- Prevents a rebuild prompt from surviving a plugin restart or an already-completed rebuild
- Markers newer than the frozen copy still show the per-folder prompt

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.5

- Fixed re-entering a folder that had just finished its first build: the page-session meta cache no longer pins `{frozen:false}`
- `onUri` always discards the cached meta for the folder being entered
- A plain HFS Reload now clears the meta cache and re-checks the folder, so it can recover without a full page refresh
- If the folder is already active, Reload triggers the complete-list assertion instead of resetting the player

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.4

- **Rebuild Frolist** is always present in a frozen folder's Folder menu
- The breathing prompt remains limited to the folder that actually changed

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.3

- Scope is strictly per folder: the dirty prompt and **Rebuild Frolist** menu item appear only in the folder that actually changed
- Other frozen folders show neither the prompt nor the menu action
- The server validates the URI inside each dirty marker, so a marker cannot affect another folder
- The confirm dialog names the folder being rebuilt

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.2

- Fixed fast folder switching sometimes leaving a frozen folder on HFS's 50-row native page
- A pending activation now retries while HFS's `state.uri` is still one tick behind instead of being discarded
- After activation the complete list is asserted several times over the next few seconds
- If HFS writes its list during our own `localListWrite` flag, the watcher re-checks shortly instead of giving up

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.1

- Replaced the DOM-cloned folder-menu item with the native `HFS.onEvent('fileMenu')` hook
- Fixes the duplicate folder menu and the unwanted navigation to the parent folder
- The item remains directly above **Reload** and no longer carries a plugin sub-label

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 5.0

- Removed the `List-cache` sub-label under **Rebuild Frolist**

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.9

- Renamed the folder-menu action to **Rebuild Frolist**
- The breathing prompt now reads `Changes detected - Folder menu > Rebuild Frolist or double click`

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.8

- Added **Rebuild Frolist** to the current folder's breadcrumb/Folder menu, directly above **Reload**
- The dirty header prompt now says `Changes detected - Folder menu > Rebuild Frolist`
- Double-clicking the status still works as a shortcut

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.7

- The "changes detected" state is stored in `storage/dirty/<hash>.json`, so every browser and account sees the rebuild prompt
- The header prompt no longer toggles text; it breathes through a JavaScript opacity animation (this also works when the OS/browser disables CSS animations)
- `lc_meta` returns `dirty`; a successful rebuild clears the marker

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.6

- Fixed the second delete crash in Videos-player
- The frozen playlist sync no longer auto-advances while HFS is remounting the file-show dialog; HFS owns the next selection
- Session delete/upload updates are applied immediately to `lc_all` but the page list is restored only after the file-show dialog actually closes
- File-show close detection is debounced (180 ms), so a transient remount no longer triggers a page-list restore in the middle of a delete

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.5

- Fixed Videos-player deletion leaving the page with a short/stale `HFS.state.list` after the player closes
- `syncLocalFileShow()` now checks whether a file-show dialog is actually visible and observes style/class/hidden changes, so a hidden leftover dialog cannot keep the page in page-slice mode
- Deletes and uploads now update the page-session `lc_all`/page list only; the frozen backend is still not rebuilt
- Videos-player 5.0 reads the updated session list, so a delete immediately reduces the playlist count instead of leaving the deleted row behind
- No new backend generation, no `lc_remove`, no `lc_invalidate` on normal operations

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.4

- Simplified to one freeze threshold; every frozen folder uses the same complete native list mode
- File operations, comments, renames, moves, uploads, and deletes no longer rebuild or invalidate the frozen listing automatically
- Changes only set the persistent dirty prompt; use Folder menu > Rebuild Frolist when you want to rebuild
- The automatic delete-generation and `lc_remove` flow was removed

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.3

- Replaced long-press rebuild with double-click / double-tap on `#lc-stats`
- Mobile double-tap no longer opens the context menu and a single tap does nothing
- The HFS confirmation and background rebuild flow is unchanged

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.2

- Fixed mobile long-press on `#lc-stats` opening the browser context menu
- Touch long-press now suppresses the context menu and either starts the rebuild timer or triggers the rebuild at the native long-press event
- A swipe still cancels the gesture; a short tap does nothing

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.1

- Long-press the `#lc-stats` header status to force a fresh frozen listing
- The action confirms in an HFS dialog, marks the listing invalid, reloads the native listing to start a background capture, and reloads the page when the new `updatedAt` is visible
- Pointer and touch handling cancel if the pointer moves, so normal header use is unaffected

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 4.0

- First-tier UI redesigned to match a native HFS folder: `HFS.state.list` holds the complete frozen listing, and HFS uses its normal page size, native pager, native sorting, filter, and file-show dialog
- List-cache now only supplies and caches the listing data; it no longer gives the UI its own page-aware list
- HFS file-show opens with the complete ordered listing, so Delete/next follows the visible order and the file list no longer disappears
- Verified with 200+ valid videos using random names containing spaces, `#`, apostrophes, parentheses, and Chinese characters
- Videos-player 4.8 does not intercept HFS's file-show menu/Delete; it only clears a stale file menu at the confirmation step and lets the existing Hotkey Delete confirm with a second Delete
- Two consecutive native deletions remain stable, with no leftover menu or extra frames

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 3.9

- HFS `fileShow` is opened with the complete ordered List-cache listing, so HFS's own Delete/next selection matches the visible playlist order
- Deleting the current video resumes with the next visibly listed item; a short watchdog re-asserts it if HFS reloads the dialog with a different entry
- Natural end of the playlist wraps to the first item and scrolls the playlist list back to the top
- Verified with 200+ valid test videos, `top/3/2/1` comments, Fixed-folder-order, and Videos-player

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 3.8

- Videos-player now consumes the exact List-cache ordered list, including the Fixed-folder-order comment-tag overlay
- A `sortCompare` fallback keeps comment-tag order in the player for lazy folders
- Playlist scroll and current-row focus remain stable when HFS remounts the file-show dialog after deletion
- Deleting the current video resumes with the next visibly listed item; natural end of the playlist wraps to the first item and scrolls the list back to the top

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 3.7

- Videos-player loads its playlist from the complete `lc_all` listing instead of the page-sized HFS state list
- Videos-player ignores page-sized HFS snapshot patches while a frozen folder is open, so deleting a video keeps the whole playlist
- Playlist scroll position and current-row focus are preserved across the dialog remount caused by HFS file operations
- `lc_all` page-session cache is also updated for lazy folders after a deletion

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 3.6

- Page-session `lc_all`/`lc_meta` caches keep the current list and Musicplayer+ playlist stable during rebuilds
- Continuous first-tier next-page loading fixed when the list watcher restores the pinned page slice
- Delete writes a new frozen generation atomically through `lc_remove`; no full rescan is required
- Comment text updates immediately; Fixed tag reordering is deferred until the next page load
- Videos-player integration uses the complete `lc_all` listing and ignores page-sized HFS state patches

Storage layout remains `VERSION_TAG = 2.6`; no database clear is required.

### 3.5

- Three tier boundaries: 200 / 5,000 / 10,000
- First tier: complete local list sorting and local paging
- Fixed-folder-order separate second list: Fixed highest priority, native order as tie-breaker
- FileShow receives the complete list in the first tier
- Header status is a single line and can share the bottom row with breadcrumb buttons on wide screens, using canvas measurement plus hysteresis to stay stable
- Native folder statistics hidden
- Internal master switch removed; enabling the plugin in HFS is enough
- Page-session snapshot: stable Musicplayer+ playlist, local delete/upload simulation, deferred Fixed comment order, background rebuild via `lc_invalidate`, and atomic delete generations via `lc_remove`

Storage layout: `VERSION_TAG = 2.6`. These frontend changes do not clear the database.

---

## Related projects

- HFS: <https://github.com/rejetto/hfs>
- This plugin: <https://github.com/hugo529100/hfs-List-cache>
- Companion plugins: Fixed-folder-order, Hide-file, Tree-nav, Musicplayer+
