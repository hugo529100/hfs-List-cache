# List-cache

List-cache is a listing cache plugin for [HFS](https://github.com/rejetto/hfs). It captures the complete file listing of large folders ahead of time, splits it into page packets, and serves those packets on later visits instead of making HFS scan the whole directory again.

Typical use cases:

- Music, photo, backup, and offline-website folders with thousands of files
- Folders where directory scanning makes the first page slow
- Keeping HFS-native sorting, comments, Fixed-folder-order, and Hide-file behavior on a frozen listing

Current plugin version: **3.5**  
Storage layout version: **2.6**  
Requirements: HFS **3.4.1** (plugin API 12.3) or a compatible version

---

## Features

- Automatically freezes folders above the configured threshold
- Splits the frozen listing into pages for fast first-page loading
- Three tiers: no freeze for small folders, a complete local list for the first tier, lazy paging for the second tier
- First tier loads the complete listing into the browser for full-list sorting, comment reordering, and full FileShow navigation
- Second tier loads only the current page and continues lazily while scrolling
- Comments are overlaid from `descript.ion` on every read, so comment edits do not require a rebuild
- Fixed-folder-order is the highest-priority sort; the first tier uses a separate second list, while the second tier applies it to the loaded page
- Hide-file rules are applied when the frozen listing is created; a rule change triggers a rebuild
- HFS native search UI is preserved; the first tier uses native HFS search, the second tier searches the frozen packets
- A one-line status appears at the bottom of the header; on wide screens it shares the bottom row with the breadcrumb buttons
- The native folder-statistics label is hidden in frozen mode to avoid duplicate counts

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

## Three tiers

| Folder entry count | Behavior |
|---|---|
| `<= minEntries` (default 200) | Not frozen; HFS native listing |
| `201 - localSortUpTo` (default 5,000) | **First tier**: one complete frozen listing; the browser loads the whole list once, then sorts and pages locally |
| `localSortUpTo + 1 - largeFoldersOver` (default 5,001 - 10,000) | **Second tier**: lazy loading; only the current page is fetched; normal validity (default 31 days) |
| `> largeFoldersOver` (default 10,000) | Second tier lazy loading with the long validity period (default 365 days) |

Thresholds are strict "greater than" comparisons:

- 200 entries: not frozen
- 201 entries: freezing starts
- 5,000 entries: first tier
- 5,001 entries: second tier
- 10,000 entries: normal validity
- 10,001 entries: long validity

If `localSortUpTo` is lower than `minEntries`, the effective first-tier ceiling is raised to `minEntries`.

---

## First tier: the complete listing in the browser

Applies to 201 - 5,000 entries by default.

1. Opening the folder returns one complete frozen listing from the backend.
2. The browser keeps the complete list as the local sorting source.
3. Only the current page is rendered (50 entries by default); thousands of DOM nodes are not created at once.
4. The plugin uses its own pager instead of the HFS native pager.
5. Sorting, paging, and comment reordering all happen in the browser.

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

Sorting applies to the complete local list, not just the current page.

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

A comment change clears and rebuilds the Fixed second list. Sort changes rebuild the corresponding caches.

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

### FileShow / image browsing

In the first tier, `HFS.state.list` normally contains only the current page. When the HFS `.file-show` dialog opens, the plugin temporarily places the complete local list into `state.list`, so FileShow can navigate every file. The current page is restored when the dialog closes.

### Header status

Frozen mode shows one line at the bottom of the header:

```text
Frozen list mode - local sort | FRO:11-25 / EXP:12-26 | 3,485 items / size: 98.4 MB
```

- On wide screens, when there is enough room on the right, it shares the bottom row with the breadcrumb buttons.
- On narrow screens or with a long path, it automatically returns to its own line.
- The native `#folder-stats` label is hidden to avoid two count modules.
- `rebuild needed` replaces `local sort` when a rebuild is required.

---

## Second tier: lazy loading

Applies to folders above `localSortUpTo` (5,000 by default).

- Opening the folder requests only the first page.
- The plugin pager at the bottom loads exactly the clicked packet.
- Scrolling near the bottom appends the next page; scrolling upward at the top loads the previous page.
- Sorting controls are disabled. The listing keeps the frozen name/folder order determined by the HFS configuration.
- Fixed-folder-order is applied only to the currently loaded page, never to the whole database.
- Search requests are answered from the frozen packets; comment search uses native HFS search.
- Very large folders use the longer validity period.

The second tier does not load the complete list into the browser, so FileShow can only navigate the currently loaded window.

---

## Search and filtering

### Search

- **First tier**: requests go to native HFS search, which searches the current folder/disk directly.
- **Second tier**: HFS search requests are answered by List-cache from the frozen packets, including paging.
- **Comment search**: always uses native HFS search, because comments may change after the freeze.
- The search dialog can explicitly request HFS native recursive search (`lcNative`).

### Filtering

- **Second tier**: opening the HFS native filter loads the complete frozen list and hands it to HFS for native filtering and paging.
- **First tier**: the list is managed by the plugin pager, so the HFS native filter only applies to the current page. Full local filtering for the first tier is not implemented yet.

---

## Comments

Comments come from `descript.ion` in the folder.

- Every page, complete listing, and search response overlays the current `descript.ion` comments.
- Editing a comment therefore does not require rebuilding the frozen listing.
- Comments changed through the HFS UI update the current list; the first-tier Fixed second list is invalidated and rebuilt.
- After editing `descript.ion` directly, reload the page or revisit the folder.
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
| Freeze folders with more entries than | 200 | Freeze only folders above this count |
| Load complete listing in the browser up to | 5000 | First-tier ceiling; larger folders use lazy loading |
| Valid for | 31 days | Validity of a normal frozen listing |
| Very large folders over | 10000 | Folders above this use the long validity period |
| Valid for very large folders | 365 days | Validity for very large folders |
| Regenerate before | empty | Listings older than this date are rebuilt on the next visit; optional |
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

1. Its validity period has expired (31 days normally, 365 days for very large folders).
2. It is older than `regenerateBefore`.
3. The folder entry count is no longer greater than `minEntries` (old database after the threshold was raised).
4. The Hide-file signature changed.
5. The storage layout version (`VERSION_TAG`) changed.
6. The HFS `page_size` changed (the whole database is cleared at startup).

A stale listing is rebuilt on the next visit. During a rebuild, requests that arrive after the build has started can still read the previous copy. The new copy is used when the build completes.

> After raising `minEntries`, old frozen databases for small folders are no longer used. The next visit goes through the HFS native listing and removes the old record.

---

## Storage layout

All data is inside the plugin storage directory:

```text
storage/
  settings.json                 pageSize used for the database
  folders.json                  uri -> { dir, count, updatedAt }
  version.json                  storage layout version
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
| `lc_all` | Reads the complete frozen listing (first-tier local sorting and filtering) |
| `lc_comment` | Reads/refreshes comment data |

The backend also hooks the HFS `get_file_list` request to intercept normal listing requests.

---

## File structure

```text
List-cache/
  plugin.js              Backend: capture, packet writing, index, validity, Hide-file, comments, API
  public/main.js         Frontend: tier entry, first-tier local sorting/paging, Fixed second list, FileShow, search UI
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

### Sorting controls are disabled

The second-tier lazy mode intentionally disables sorting to avoid sorting only the current page incorrectly. To get full sorting, raise `localSortUpTo` so the folder falls into the first tier.

### Fixed order does not take effect

Check:

1. Fixed-folder-order is enabled in HFS.
2. **Enable Custom Sorting** is enabled in its Options dialog.
3. `commentOrderEnabled` is true.
4. The files really have `descript.ion` comments.
5. The second tier applies Fixed only to the loaded page; the first tier uses the complete second list.

### The order does not change after editing a comment

- Comment changed through the HFS UI: the current page refreshes and the first-tier Fixed list is rebuilt.
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
- The first-tier HFS native filter applies only to the current page; full local filtering is not implemented yet.
- In the second tier, FileShow can navigate only the loaded window.
- The second tier disables sorting controls and applies Fixed only to the current page.
- Comments are read from `descript.ion`; external edits require a page reload.
- Extremely large directories above 3,000,000 entries hit the capture safety limit.

---

## Development notes

- Backend entry point: `exports.init(api)` in `plugin.js`
- Frontend entry points: `public/main.js`, `public/style.css`
- Storage layout constants: `FORMAT`, `VERSION_TAG`
- First-tier test: `meta.count <= localSortThreshold()`
- First-tier local sorting: `localPureOrder()` and `localOrderForCurrentSort()` in `public/main.js`
- Fixed second list: the stable overlay sort inside `localOrderForCurrentSort()`
- Syntax check after changes:

  ```bash
  node --check plugin.js
  node --check public/main.js
  ```

- Do not raise `VERSION_TAG` for frontend-only changes; doing so clears and rebuilds every frozen database.

---

## Version history

### 3.5

- Three tier boundaries: 200 / 5,000 / 10,000
- First tier: complete local list sorting and local paging
- Fixed-folder-order separate second list: Fixed highest priority, native order as tie-breaker
- FileShow receives the complete list in the first tier
- Header status is a single line and shares the bottom row with breadcrumb buttons on wide screens
- Native folder statistics hidden
- Internal master switch removed; enabling the plugin in HFS is enough

Storage layout: `VERSION_TAG = 2.6`. These frontend changes do not clear the database.

---

## Related projects

- HFS: <https://github.com/rejetto/hfs>
- This plugin: <https://github.com/hugo529100/hfs-List-cache>
- Companion plugins: Fixed-folder-order, Hide-file, Tree-nav, Musicplayer+
