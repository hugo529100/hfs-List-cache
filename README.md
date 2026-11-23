// List-cache 3.5
// Keeps a frozen copy of the listing of very big folders in the plugin storage, and
// serves it page by page ("lazy"): opening the folder only loads the first page.
// The page bar loads exactly the clicked packet; scrolling near the bottom appends the
// next packet, so the list continues without a jump. Searching works on these packets:
// the frontend filters them and asks for the next packet only when needed.
//
// HFS's own search UI is kept: its search requests are answered from the frozen packets,
// page by page. The native filter bar can also ask for the complete listing at once
// (lc_all) and then page/filter it natively. Comment searches always use HFS's native
// search, because comments may be edited after the frozen copy was taken.
//
// Comments are also overlaid from the folder's descript.ion whenever a page, a search
// result or the full listing is served, so editing a comment does not require rebuilding
// the frozen copy. Fixed-folder-order is applied in the browser to each loaded page
// (HFS's sortCompare event), so its rules never require rebuilding the database.
// Hide-file's rules are applied at the same time, with their own signature, because that
// plugin is frontend-only and a frozen list would otherwise bypass it.
//
// Ordering is forced to name (folders first): the frozen pages are written in that order,
// and the web UI is kept on that order too, so the sort controls do nothing.
//
// The frozen copy is just the file list that HFS already produced: who may open a folder
// is still decided by HFS. A listing is replayed only for an account that HFS has already
// served that folder to (the account is recorded in meta.json). Any other account goes
// through HFS as usual, and gets recorded when HFS answers.
//
// Page size comes from the server config (page_size), not from the plugin panel. The value
// is remembered in settings.json: when it changes, restarting HFS (or the plugin) clears
// the frozen database, and the next visit rebuilds it with the new page size.
//
// Storage layout (all inside the plugin storage folder), one packet per page. JSON files
// are written with line breaks (one entry per line in the packets) to stay manageable.
//   settings.json                   pageSize actually used; a different page_size wipes lists
//   folders.json                    index: uri -> { dir, count, updatedAt }
//   version.json                    layout version; a different layout wipes everything
//   lists/<folder>-<hash>/
//     <gen>/meta.json               format, uri, count, pageSize, updatedAt, gen, chunks, accounts
//     <gen>/c0000.json              array of ["+", entry], one page
//     <gen>/c0001.json
//     ...
//
// A listing longer than the configured threshold is frozen. It is frozen again when
// older than "valid for" (31 days by default) or older than the optional
// "regenerate before" date, on the next visit; while that happens the previous copy
// keeps being served. Very large folders (over 100k entries by default) use a longer
// validity, 365 days by default.
//
// Integrity: the listing is parsed while it streams and is saved only after HFS sent
// its final empty frame; a dropped/truncated stream is discarded. Packets are built in a
// temporary generation folder, and the generation is renamed into place only after all
// packets are written and counted; meta.json is written last. A partial build is never
// referenced.
