// List-cache 5.4
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

exports.version = 5.4
exports.description = "Freezes listings of very big folders and serves them page by page, lazily. The first visit starts building the frozen list; the next visit opens instantly."
exports.apiRequired = 12.3
exports.repo = "hugo529100/hfs-List-cache"
exports.frontend_js = 'main.js'
exports.frontend_css = 'style.css'
exports.config = {
    minEntries: {
        type: 'number',
        defaultValue: 200,
        min: 1,
        label: "Freeze folders with more entries than",
        helperText: "Every frozen folder uses the same complete-list mode"
    },
    rebuildAfterDays: {
        type: 'number',
        defaultValue: 31,
        min: 0.001,
        unit: "days",
        label: "Valid for",
        helperText: "A frozen listing older than this is built again on the next visit"
    },
    regenerateBefore: {
        type: 'date_time',
        label: "Regenerate before",
        helperText: "Listings older than this date are built again",
        xs: 6
    },
    debug: {
        type: 'boolean',
        defaultValue: false,
        label: "Debug log"
    }
}

exports.init = async api => {
    const fs = api.require('fs')
    const path = api.require('path')
    const crypto = api.require('crypto')
    const { Transform, Readable } = api.require('stream')
    const fsp = fs.promises

    const API_PATH = '/~/api/get_file_list'
    const FORMAT = 7
    const VERSION_TAG = '2.6' // storage layout ONLY: bump it only when meta/chunks change format,
                             // because a different value clears the frozen database.
                             // exports.version is informational and never clears storage.
    const DAY = 86400000
    const MAX_CAPTURE_ENTRIES = 3_000_000 // safety stop for extreme folders

    const storageDir = String(api.storageDir || '')
    if (!storageDir)
        return
    const LISTS_DIR = path.join(storageDir, 'lists')
    const INDEX_FILE = path.join(storageDir, 'folders.json')
    const VERSION_FILE = path.join(storageDir, 'version.json')
    const SETTINGS_FILE = path.join(storageDir, 'settings.json')

    const cfg = key => api.getConfig(key)
    const debugOn = () => cfg('debug') === true
    const log = (...args) => {
        if (!debugOn())
            return
        // api.log also feeds the plugin's log panel in the backend, which is only wanted
        // while "debug" is on
        api.log('[List-cache]', ...args)
    }
    const dbg = (...args) => {
        if (!debugOn())
            return
        log(...args)
        try {
            fs.appendFileSync(path.join(storageDir, 'debug.log'),
                new Date().toISOString() + ' ' + args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n')
        }
        catch { /* logging must never break the plugin */ }
    }
    const positive = (value, fallback) => {
        const n = Number(value)
        return Number.isFinite(n) && n > 0 ? n : fallback
    }
    // every message goes through the "debug" switch of the plugin settings
    const threshold = () => Math.max(1, positive(cfg('minEntries'), 200))
    const maxAge = () => positive(cfg('rebuildAfterDays'), 31) * DAY

    // page size is a server setting (config.yaml page_size), read again on every restart
    let currentPageSize = 100
    function serverPageSize(fallback) {
        try {
            return Math.max(1, Math.floor(positive(api.getHfsConfig('page_size'), fallback)))
        }
        catch (e) { return fallback }
    }

    function isStale(meta) {
        const ts = Date.parse(meta && meta.updatedAt || '')
        if (!Number.isFinite(ts))
            return true
        // the threshold moved above this folder: it should no longer be frozen
        if (Number(meta.count) <= threshold())
            return true
        // a file operation explicitly marked this listing as stale
        if (isInvalid(meta.uri))
            return true
        // Hide-file rules changed (or the plugin was disabled) -> rebuild the visible set
        if (meta.hideSignature !== hideSignature())
            return true
        const cutoff = cfg('regenerateBefore')
        if (cutoff) {
            const cutoffMs = new Date(cutoff).getTime()
            if (Number.isFinite(cutoffMs) && cutoffMs <= Date.now() && ts < cutoffMs)
                return true
        }
        return Date.now() - ts > maxAge(meta)
    }

    let index = { format: FORMAT, folders: {} }
    let ready = false // never start a capture while a hot reload is still loading the index
    const metaCache = new Map() // folder dir -> { mtimeMs, meta }
    const building = new Set()  // "uri|account" being rebuilt
    const captureProgress = new Map() // "uri|account" -> { count, large } while learning a listing
    let genSeq = 0

    let ioQueue = Promise.resolve()
    const queueIo = fn => (ioQueue = ioQueue.then(fn, fn).catch(e => dbg('io error', String(e))))

    async function writeFileAtomic(file, text) {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fsp.writeFile(tmp, text, 'utf8')
        await fsp.rename(tmp, file)
    }

    const saveIndex = () => queueIo(() => writeFileAtomic(INDEX_FILE, JSON.stringify(index, null, 2)))

    const normalizeUri = uri => {
        let u = typeof uri === 'string' ? uri : '/'
        if (!u.startsWith('/'))
            u = '/' + u
        if (!u.endsWith('/'))
            u += '/'
        return u
    }

    const userOf = ctx => {
        try { return String(api.getCurrentUsername(ctx) || '') }
        catch { return '' }
    }

    const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)

    const INVALID_DIR = path.join(storageDir, 'invalid')
    const invalidFileFor = uri => path.join(INVALID_DIR, hash(uri) + '.json')
    const isInvalid = uri => {
        try { return fs.existsSync(invalidFileFor(uri)) }
        catch { return false }
    }
    const markInvalid = uri => queueIo(() => writeFileAtomic(invalidFileFor(uri),
        JSON.stringify({ uri, at: new Date().toISOString() }, null, 2)))
    const clearInvalid = uri => fsp.rm(invalidFileFor(uri), { force: true }).catch(() => {})

    // Persistent "changed since freeze" marker. It lives in storage, so every
    // browser/account sees the rebuild prompt, not only the browser that edited.
    const DIRTY_DIR = path.join(storageDir, 'dirty')
    const dirtyFileFor = uri => path.join(DIRTY_DIR, hash(uri) + '.json')
    const isDirty = async uri => {
        try {
            const rec = JSON.parse(await fsp.readFile(dirtyFileFor(uri), 'utf8'))
            return Boolean(rec && rec.at && rec.uri === uri)
        }
        catch { return false }
    }
    const markDirty = uri => queueIo(() => writeFileAtomic(dirtyFileFor(uri),
        JSON.stringify({ uri, at: new Date().toISOString() }, null, 2)))
    const clearDirty = uri => fsp.rm(dirtyFileFor(uri), { force: true }).catch(() => {})

    function dirFor(uri) {
        const slug = uri.replace(/^\/+/, '')
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80) || 'root'
        return path.join(LISTS_DIR, `${slug}-${hash(uri)}`)
    }

    // ---- start-up: layout version and page_size both clear the frozen database ------------

    async function wipeLists() {
        try { await fsp.rm(LISTS_DIR, { recursive: true, force: true }) }
        catch { /* nothing to clean */ }
        try { await fsp.rm(path.join(storageDir, 'snapshots'), { recursive: true, force: true }) }
        catch { /* nothing to clean */ }
        try { await fsp.rm(INVALID_DIR, { recursive: true, force: true }) }
        catch { /* nothing to clean */ }
        try { await fsp.rm(DIRTY_DIR, { recursive: true, force: true }) }
        catch { /* nothing to clean */ }
        index = { format: FORMAT, folders: {} }
        metaCache.clear()
        await writeFileAtomic(INDEX_FILE, JSON.stringify(index, null, 2))
    }

    async function enforceVersion() {
        let stored = null
        try { stored = JSON.parse(await fsp.readFile(VERSION_FILE, 'utf8')).version }
        catch { /* first run */ }
        if (stored === VERSION_TAG) {
            // keep even this small file readable when it was written by an older version
            try {
                const text = await fsp.readFile(VERSION_FILE, 'utf8')
                if (!text.includes('\n'))
                    await writeFileAtomic(VERSION_FILE, JSON.stringify(JSON.parse(text), null, 2))
            }
            catch { /* ignore a damaged version file */ }
            return loadIndex()
        }
        await wipeLists()
        await writeFileAtomic(VERSION_FILE, JSON.stringify({ version: VERSION_TAG, at: new Date().toISOString() }, null, 2))
        if (stored)
            log('plugin version changed (' + stored + ' -> ' + VERSION_TAG + '), frozen lists cleared')
    }

    async function loadIndex() {
        let old = null
        try { old = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8')) }
        catch { /* none */ }
        if (old && old.format === FORMAT && old.folders && typeof old.folders === 'object') {
            index = old
            return
        }
        if (old && old.folders) {
            for (const rec of Object.values(old.folders)) {
                if (rec && typeof rec.file === 'string')
                    try { await fsp.unlink(rec.file) }
                    catch { /* gone */ }
                if (rec && typeof rec.dir === 'string')
                    try { await fsp.rm(rec.dir, { recursive: true, force: true }) }
                    catch { /* gone */ }
            }
        }
        index = { format: FORMAT, folders: {} }
        await writeFileAtomic(INDEX_FILE, JSON.stringify(index, null, 2))
    }

    // page size comes from the server config; settings.json remembers the value we built
    // the database with, so a change can clear it on this restart
    async function readStoredPageSize() {
        try {
            const saved = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'))
            const n = Math.floor(positive(saved && saved.pageSize, 0))
            if (n > 0)
                return n
        }
        catch { /* first run with settings.json */ }
        // before 3.0 the plugin panel option was the effective page size
        return Math.max(1, Math.floor(positive(cfg('pageSize'), 100)))
    }

    async function enforcePageSize() {
        const previous = await readStoredPageSize()
        const current = serverPageSize(previous)
        if (previous !== current) {
            await wipeLists()
            log('page_size changed (' + previous + ' -> ' + current + '), frozen database cleared')
        }
        currentPageSize = current
        await writeFileAtomic(SETTINGS_FILE, JSON.stringify({
            pageSize: current,
            at: new Date().toISOString()
        }, null, 2))
    }

    await enforceVersion()
    await enforcePageSize()
    ready = true

    async function readMeta(dir) {
        const file = path.join(dir, 'meta.json')
        let st
        try { st = await fsp.stat(file) }
        catch { return null }
        let meta
        const cached = metaCache.get(dir)
        if (cached && cached.mtimeMs === st.mtimeMs)
            meta = cached.meta
        else {
            try {
                meta = JSON.parse(await fsp.readFile(file, 'utf8'))
                if (!meta || meta.format !== FORMAT || !meta.gen || !Array.isArray(meta.chunks))
                    return null
                if (!meta.accounts || typeof meta.accounts !== 'object')
                    meta.accounts = {}
            }
            catch { return null }
        }
        const genStat = await fsp.stat(path.join(dir, meta.gen)).catch(() => null)
        if (!genStat || !genStat.isDirectory()) {
            metaCache.delete(dir)
            return null
        }
        metaCache.set(dir, { mtimeMs: st.mtimeMs, meta })
        return meta
    }

    async function cleanupOldGens(dir) {
        const meta = await readMeta(dir)
        if (!meta || !meta.gen)
            return
        let entries
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) }
        catch { return }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === meta.gen)
                continue
            try { await fsp.rm(path.join(dir, entry.name), { recursive: true, force: true }) }
            catch { /* in use */ }
        }
    }

    api.setTimeout(() => {
        for (const rec of Object.values(index.folders))
            cleanupOldGens(rec.dir).catch(() => {})
    }, 5_000)

    // ---- serving ------------------------------------------------------------------------

    // frozen pages follow the HFS name ordering (direction and options come from the HFS
    // config), so page boundaries match what the native listing would show
    function sortPrefs() {
        const get = (key, fallback) => {
            try {
                const v = api.getHfsConfig(key)
                return v === undefined ? fallback : v
            }
            catch { return fallback }
        }
        return {
            invert: get('invert_order', false) === true,
            numeric: get('sort_numerics', false) === true,
            foldersFirst: get('folders_first', true) !== false
        }
    }

    function compareNames(a, b, prefs) {
        const ao = a.order || 0, bo = b.order || 0
        if (ao !== bo)
            return bo - ao
        const af = a.n.endsWith('/'), bf = b.n.endsWith('/')
        if (prefs.foldersFirst && af !== bf)
            return af ? -1 : 1
        const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: prefs.numeric })
        const r = collator.compare(a.n, b.n)
        return prefs.invert ? -r : r
    }

    // ---- Hide-file integration ------------------------------------------------------------
    // Hide-file is a frontend plugin (newListEntries), which a frozen list bypasses. Its
    // rules are applied when the copy is built, and a signature forces a rebuild when they
    // change or when the plugin is disabled.

    function hideRawConfig() {
        let all
        try { all = api.getHfsConfig('plugins_config') }
        catch { return null }
        const cfg = all && (all['Hide-file'] || all['hide-file'])
        if (!cfg || typeof cfg !== 'object')
            return null
        try {
            const enabled = api.getHfsConfig('enable_plugins')
            if (Array.isArray(enabled) && !enabled.some(x => String(x).toLowerCase() === 'hide-file'))
                return null
        }
        catch { /* no enabled list: keep the rules */ }
        return cfg
    }

    function hideSignature() {
        return hash(JSON.stringify(hideRawConfig()))
    }

    function makeHideMatcher(pattern) {
        const escaped = String(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
        try { return new RegExp('^' + escaped + '$', 'i') }
        catch { return null }
    }

    function hideList(value) {
        return String(value || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean)
    }

    let hideCache = { signature: null, rules: null }
    function hideRules() {
        const cfg = hideRawConfig()
        const signature = hideSignature()
        if (hideCache.signature === signature)
            return hideCache.rules
        const rules = cfg ? {
            files: hideList(cfg.hideFiles).map(makeHideMatcher).filter(Boolean),
            exact: new Set(hideList(cfg.hideExactFiles).map(x => x.toLowerCase())),
            folders: hideList(cfg.hideFolders).map(makeHideMatcher).filter(Boolean)
        } : null
        hideCache = { signature, rules }
        return rules
    }

    function isHidden(entry, rules) {
        if (!rules)
            return false
        const isFolder = entry.n.endsWith('/')
        const base = isFolder ? entry.n.slice(0, -1) : entry.n
        const name = base.slice(base.lastIndexOf('/') + 1)
        if (isFolder)
            return rules.folders.some(re => re.test(name))
        return rules.files.some(re => re.test(name)) || rules.exact.has(name.toLowerCase())
    }

    function propsFor(meta, account) {
        const acc = meta.accounts && meta.accounts[account]
        if (acc && acc.props)
            return acc.props
        const any = meta.accounts && Object.values(meta.accounts)[0]
        return (any && any.props) || {}
    }

    // same letters HFS shows in its alphabet paging, mapped to the page holding the letter
    function alphabetIndex(entries, perPage) {
        const out = {}
        entries.forEach((entry, idx) => {
            const base = entry.n.endsWith('/') ? entry.n.slice(0, -1) : entry.n
            const name = base.slice(base.lastIndexOf('/') + 1).trim()
            const first = Array.from(name)[0]
            if (!first)
                return
            const latin = first.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase()
            const upper = first.toLocaleUpperCase()
            const label = /^[A-Z]$/.test(latin) ? latin : /\p{Letter}/u.test(upper) ? upper : ''
            if (!label || out[label] !== undefined)
                return
            out[label] = Math.floor(idx / perPage) + 1
        })
        return out
    }

    // SSE: only the first page, plus the end marker. The rest is fetched by the page bar.
    async function* replayFirstPage(ctx, uri, dir, meta, account) {
        yield 'data: ' + JSON.stringify([['props', propsFor(meta, account)]]) + '\n\n'
        try {
            const text = await fsp.readFile(path.join(dir, meta.gen, meta.chunks[0]), 'utf8')
            const ops = JSON.parse(text)
            const entries = []
            for (const op of ops)
                if (Array.isArray(op) && op[0] === '+' && op[1])
                    entries.push(op[1])
            try { await overlayComments(uri, entries) }
            catch (e) { /* comments must not break the listing */ }
            yield 'data: ' + JSON.stringify(ops) + '\n\n'
        }
        catch (e) {
            dbg('missing packet', dir, meta.gen, meta.chunks[0], String(e))
            yield 'data: ' + JSON.stringify([['e', 'frozen listing incomplete']]) + '\n\n'
        }
        yield 'data:\n\n'
    }

    function serveSse(ctx, uri, dir, meta, account) {
        ctx.status = 200
        ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        })
        ctx.body = Readable.from(replayFirstPage(ctx, uri, dir, meta, account))
        dbg('served first page', uri, account || '(anonymous)', meta.count)
    }

    async function fullList(dir, meta) {
        const list = []
        for (const name of meta.chunks) {
            const text = await fsp.readFile(path.join(dir, meta.gen, name), 'utf8')
            for (const op of JSON.parse(text))
                if (Array.isArray(op) && op[0] === '+' && op[1])
                    list.push(op[1])
        }
        return list
    }

    // ---- live comments from the folder's descript.ion ------------------------------------
    // A frozen entry is a snapshot; comments are edited afterwards and HFS stores them in
    // descript.ion. Reading that file (cached by mtime) keeps comments current without
    // rebuilding the whole frozen database.

    const commentCache = new Map()

    function decodeSegment(s) {
        try { return decodeURIComponent(s) }
        catch { return s }
    }

    function sourceDirFor(uri) {
        let root
        try { root = api.getHfsConfig('vfs') } catch { return null }
        if (!root)
            return null
        const segs = String(uri).split('/').filter(Boolean).map(decodeSegment)
        let node = root
        let base = typeof root.source === 'string' ? root.source : null
        const rest = []
        for (const seg of segs) {
            const children = Array.isArray(node.children) ? node.children : []
            const child = children.find(c => c && c.name === seg)
            if (child) {
                node = child
                if (typeof child.source === 'string') {
                    base = child.source
                    rest.length = 0
                }
                if (child.url)
                    return null
            }
            else {
                if (!base)
                    return null
                rest.push(seg)
            }
        }
        if (!base)
            return null
        try { return path.resolve(base, ...rest) }
        catch { return null }
    }

    function parseDescriptIon(text) {
        const map = new Map()
        for (let line of String(text).split('\n')) {
            if (line.endsWith('\r'))
                line = line.slice(0, -1)
            if (!line)
                continue
            const quoted = line[0] === '"' ? 1 : 0
            const sep = quoted ? line.indexOf('"', 2) + 1 : line.indexOf(' ')
            if (sep <= 0)
                continue
            const name = line.slice(quoted, sep - quoted)
            if (!name)
                continue
            map.set(name, line.slice(sep + 1).replaceAll('\\n', '\n'))
        }
        return map
    }

    async function readLiveComments(dir) {
        let storage = ''
        try { storage = String(api.getHfsConfig('comments_storage') || '') }
        catch { /* default is descript.ion */ }
        if (storage === 'attr')
            return null // comments are stored in file attributes, not in descript.ion
        const file = path.join(dir, 'descript.ion')
        let st
        try { st = await fsp.stat(file) }
        catch {
            // no file means no comments; remove stale frozen comments in the default mode
            return storage === '' ? new Map() : null
        }
        const cached = commentCache.get(dir)
        if (cached && cached.mtimeMs === st.mtimeMs)
            return cached.map
        let text
        try { text = await fsp.readFile(file, 'utf8') }
        catch { return null }
        const map = parseDescriptIon(text)
        commentCache.set(dir, { mtimeMs: st.mtimeMs, map })
        return map
    }

    function applyComments(entries, map) {
        if (!map)
            return
        for (const entry of entries) {
            if (!entry || typeof entry.n !== 'string')
                continue
            const base = entry.n.endsWith('/') ? entry.n.slice(0, -1) : entry.n
            const name = base.slice(base.lastIndexOf('/') + 1)
            if (map.has(name)) {
                const comment = map.get(name)
                if (comment)
                    entry.comment = comment
                else
                    delete entry.comment
            }
            else if (entry.comment)
                delete entry.comment
        }
    }

    async function overlayComments(uri, entries) {
        if (!entries || !entries.length)
            return entries
        const dir = sourceDirFor(uri)
        if (!dir)
            return entries
        applyComments(entries, await readLiveComments(dir))
        return entries
    }

    // ---- searching inside the frozen listing --------------------------------------------

    // same meaning as HFS: search/searchComment are lowercased, and with wild=no they are
    // literal substrings, otherwise picomatch-like wildcards (* ? | {a,b}) are used
    function splitAlternatives(pattern) {
        const out = []
        let depth = 0, start = 0
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i]
            if (c === '{')
                depth++
            else if (c === '}')
                depth = Math.max(0, depth - 1)
            else if (c === '|' && !depth) {
                out.push(pattern.slice(start, i))
                start = i + 1
            }
        }
        out.push(pattern.slice(start))
        return out.filter(Boolean)
    }

    function expandBraces(pattern) {
        const i = pattern.indexOf('{')
        if (i < 0)
            return [pattern]
        const j = pattern.indexOf('}', i)
        if (j < 0)
            return [pattern]
        const pre = pattern.slice(0, i)
        const post = pattern.slice(j + 1)
        return pattern.slice(i + 1, j).split(',').flatMap(alt => expandBraces(pre + alt + post))
    }

    function wildcardMatcher(pattern) {
        let negate = false
        if (pattern.startsWith('!')) {
            negate = true
            pattern = pattern.slice(1)
        }
        // HFS wraps each alternative with *...* unless the pattern already contains a *
        const source = pattern.includes('*')
            ? pattern
            : pattern.split('|').map(part => `*${part}*`).join('|')
        const alternatives = splitAlternatives(source)
            .flatMap(expandBraces)
            .map(one => one
                .replace(/[.+^$()\\[\]{}]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.'))
        let re = null
        try { re = new RegExp('^(?:' + alternatives.join('|') + ')$', 'i') }
        catch (e) { return () => false }
        return s => {
            const hit = re.test(s)
            return negate ? !hit : hit
        }
    }

    function searchMatcher(params) {
        const wild = params.wild === 'no'
        const name = String(params.search || '').toLocaleLowerCase()
        const comment = String(params.searchComment || '').toLocaleLowerCase()
        const nameMatch = name ? (wild ? s => s.includes(name) : wildcardMatcher(name)) : null
        const commentMatch = comment ? (wild ? s => s.includes(comment) : wildcardMatcher(comment)) : null
        const onlyFolders = Boolean(params.onlyFolders)
        const onlyFiles = Boolean(params.onlyFiles)
        return entry => {
            if (!entry || typeof entry.n !== 'string')
                return false
            const isFolder = entry.n.endsWith('/')
            if (onlyFolders && !isFolder || onlyFiles && isFolder)
                return false
            if (!nameMatch && !commentMatch)
                return true
            const base = isFolder ? entry.n.slice(0, -1) : entry.n
            const short = base.slice(base.lastIndexOf('/') + 1)
            // HFS lowercases the query but not the name for literal (wild=no) searches:
            // wildcard matching is nocase, literal matching keeps that exact behavior
            if (nameMatch && !nameMatch(short))
                return false
            if (commentMatch && !commentMatch(String(entry.comment || '')))
                return false
            return true
        }
    }

    async function searchEntries(dir, meta, params) {
        const match = searchMatcher(params)
        const out = []
        for (const name of meta.chunks) {
            // a missing/corrupt packet must not silently produce a partial search:
            // this throws, and the caller falls back to HFS's native search
            const ops = JSON.parse(await fsp.readFile(path.join(dir, meta.gen, name), 'utf8'))
            for (const op of ops)
                if (Array.isArray(op) && op[0] === '+' && op[1] && match(op[1]))
                    out.push(op[1])
        }
        return out
    }

    async function* replaySearch(uri, dir, meta, account, params, aborted, cleanup) {
        try {
            yield 'data: ' + JSON.stringify([['props', propsFor(meta, account)]]) + '\n\n'
            const match = searchMatcher(params)
            for (const name of meta.chunks) {
                if (aborted())
                    return
                let ops
                try {
                    ops = JSON.parse(await fsp.readFile(path.join(dir, meta.gen, name), 'utf8'))
                }
                catch (e) {
                    dbg('search read error', dir, meta.gen, name, String(e))
                    yield 'data: ' + JSON.stringify([['e', 'frozen listing incomplete']]) + '\n\n'
                    return
                }
                const hits = []
                for (const op of ops)
                    if (Array.isArray(op) && op[0] === '+' && op[1] && match(op[1]))
                        hits.push(['+', op[1]])
                if (hits.length) {
                    try { await overlayComments(uri, hits.map(h => h[1])) }
                    catch (e) { /* comments must not break the search */ }
                    yield 'data: ' + JSON.stringify(hits) + '\n\n'
                }
                // give the event loop a chance to notice stop/disconnect between packets
                await new Promise(resolve => setImmediate(resolve))
            }
            yield 'data:\n\n'
        }
        finally { cleanup() }
    }

    function serveSearchSse(ctx, uri, dir, meta, account, params) {
        let stopped = false
        const onClose = () => { stopped = true }
        ctx.req.on('close', onClose)
        ctx.res.on('close', onClose)
        const cleanup = () => {
            ctx.req.off?.('close', onClose)
            ctx.res.off?.('close', onClose)
        }
        ctx.status = 200
        ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        })
        ctx.body = Readable.from(replaySearch(uri, dir, meta, account, params, () => stopped, cleanup))
        dbg('served frozen search', uri, account || '(anonymous)',
            JSON.stringify({ search: params.search, searchComment: params.searchComment, wild: params.wild }))
    }


    // ---- learning a listing --------------------------------------------------------------

    async function considerSave(uri, account, list, props) {
        // refresh comments from descript.ion before sorting, so comment tags are current
        const source = sourceDirFor(uri)
        if (source)
            applyComments(list, await readLiveComments(source))
        // Hide-file works in the frontend; apply its rules before counting/sorting the copy
        const rules = hideRules()
        const clean = list.filter(entry => entry && typeof entry.n === 'string' && !isHidden(entry, rules))
        if (!clean.length) {
            dbg('empty listing, not freezing', uri)
            return
        }
        const rec = index.folders[uri]
        if (clean.length <= threshold()) {
            if (rec) {
                dbg('listing shrank, dropping', uri, clean.length)
                await dropFolder(uri)
            }
            return
        }
        const prefs = sortPrefs()
        clean.sort((a, b) => compareNames(a, b, prefs))
        const perPage = pageSize()

        const dir = (rec && rec.dir) || dirFor(uri)
        const gen = `${Date.now()}-${++genSeq}`
        const finalDir = path.join(dir, gen)
        // build aside; the generation becomes visible only after every packet is written
        const tmpDir = path.join(dir, '.tmp-' + gen)
        const chunks = []
        let written = 0
        try {
            await fsp.mkdir(tmpDir, { recursive: true })
            for (let i = 0; i < clean.length; i += perPage) {
                const name = 'c' + String(chunks.length).padStart(4, '0') + '.json'
                const slice = clean.slice(i, i + perPage)
                // one entry per line, so the database stays readable by hand
                const text = '[\n' + slice.map(entry => JSON.stringify(['+', entry])).join(',\n') + '\n]'
                await fsp.writeFile(path.join(tmpDir, name), text, 'utf8')
                chunks.push(name)
                written += slice.length
            }
            if (written !== clean.length)
                throw new Error('packet count mismatch')
            await fsp.rename(tmpDir, finalDir)
        }
        catch (e) {
            await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
            throw e
        }

        const previous = await readMeta(dir)
        const accounts = { ...(previous && previous.accounts) }
        accounts[account] = { ts: Date.now(), props }
        const bytes = clean.reduce((sum, entry) => sum + (Number(entry.s) || 0), 0)
        const meta = {
            format: FORMAT,
            uri,
            count: clean.length,
            pageSize: perPage,
            bytes,
            updatedAt: new Date().toISOString(),
            gen,
            chunks,
            alphabet: alphabetIndex(clean, perPage),
            sort: prefs,
            hideSignature: hideSignature(),
            accounts
        }
        await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
        metaCache.delete(dir)
        index.folders[uri] = {
            uri,
            dir,
            count: clean.length,
            updatedAt: meta.updatedAt
        }
        await saveIndex()
        await clearInvalid(uri)
        await clearDirty(uri)
        log('frozen', uri, clean.length, 'in', chunks.length, 'pages ->', dir)
        api.setTimeout(() => cleanupOldGens(dir).catch(() => {}), 60_000)
    }

    async function dropFolder(uri) {
        const rec = index.folders[uri]
        if (!rec)
            return
        delete index.folders[uri]
        await saveIndex()
        metaCache.delete(rec.dir)
        try { await fsp.rm(rec.dir, { recursive: true, force: true }) }
        catch { /* already gone */ }
        await clearInvalid(uri)
        await clearDirty(uri)
    }

    function pageSize() {
        return currentPageSize
    }

    function startCapture(ctx, uri, account) {
        const key = uri + '|' + account
        building.add(key)
        captureProgress.set(key, { count: 0, large: false })
        // very large folders can take a long time; keep the key while the stream runs
        const timer = api.setTimeout(() => building.delete(key), 30 * 60_000)
        let finished = false
        const finish = () => {
            if (finished)
                return
            finished = true
            clearTimeout(timer)
            building.delete(key)
            captureProgress.delete(key)
        }
        return function after() {
            try {
                const body = ctx.body
                if (!body) {
                    finish()
                    return
                }
                if (typeof body === 'string' || body instanceof Buffer || !body.list && !body.pipe) {
                    finish()
                    return
                }
                if (typeof body.pipe === 'function') {
                    captureStream(ctx, body, uri, account, finish)
                    return
                }
                if (Array.isArray(body.list)) {
                    if (body.error) {
                        finish()
                        return
                    }
                    const props = { ...body }
                    delete props.list
                    considerSave(uri, account, body.list, props)
                        .catch(e => dbg('save error', String(e)))
                        .finally(finish)
                    return
                }
                finish()
            }
            catch (e) {
                dbg('capture error', String(e))
                finish()
            }
        }
    }

    // Parse the listing while it streams (instead of buffering a possibly huge text):
    // entries are collected frame by frame, and a save is attempted only after the whole
    // stream ended with HFS's final empty "data:" frame. A dropped connection or a
    // malformed/truncated stream therefore never produces a frozen generation.
    function captureStream(ctx, body, uri, account, finish) {
        const entries = []
        const props = {}
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let bytes = 0
        let failed = false
        let tooBig = false
        let endMarker = false
        let done = false

        function consumeFrame(frame) {
            const text = frame.trim()
            if (!text.startsWith('data:'))
                return
            const payload = text.slice(5).trim()
            if (!payload) {
                endMarker = true
                return
            }
            if (endMarker) { // data after the final frame: truncated/duplicated stream
                failed = true
                return
            }
            let ops
            try { ops = JSON.parse(payload) }
            catch { failed = true; return }
            if (!Array.isArray(ops)) {
                failed = true
                return
            }
            for (const op of ops) {
                if (!Array.isArray(op)) {
                    failed = true
                    return
                }
                const kind = op[0]
                if (kind === 'props' && op[1] && typeof op[1] === 'object')
                    Object.assign(props, op[1])
                else if (kind === '+') {
                    if (Array.isArray(op[1])) {
                        for (const entry of op[1])
                            entries.push(entry)
                    }
                    else if (op[1])
                        entries.push(op[1])
                    const progress = captureProgress.get(uri + '|' + account)
                    if (progress) {
                        progress.count = entries.length
                        if (!progress.large && entries.length > threshold())
                            progress.large = true
                    }
                    if (entries.length > MAX_CAPTURE_ENTRIES) {
                        tooBig = true
                        return
                    }
                }
                else if (kind === 'e') {
                    failed = true
                    return
                }
            }
        }

        function pushText(text) {
            bytes += text.length
            buffer += text
            let m
            while (!failed && (m = buffer.match(/\r?\n\r?\n/))) {
                const frame = buffer.slice(0, m.index)
                buffer = buffer.slice(m.index + m[0].length)
                consumeFrame(frame)
            }
            // no legitimate SSE frame is this large; treat it as damaged
            if (buffer.length > 32 * 1024 * 1024)
                failed = true
        }

        const tee = new Transform({
            transform(chunk, enc, cb) {
                try {
                    if (!failed && !tooBig) {
                        // decode progressively: a chunk boundary may split a UTF-8 character
                        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
                        pushText(text)
                    }
                }
                catch (e) { failed = true }
                cb(null, chunk)
            },
            flush(cb) {
                try {
                    if (!failed && !tooBig)
                        pushText(decoder.decode())
                }
                catch (e) { failed = true }
                cb()
            }
        })
        body.pipe(tee)
        ctx.body = tee
        tee.on('end', () => {
            if (done)
                return
            done = true
            if (tooBig) {
                dbg('listing too big to freeze', uri, entries.length)
                return finish()
            }
            if (failed) {
                dbg('listing stream malformed, not freezing', uri)
                return finish()
            }
            if (buffer.trim()) {
                dbg('listing stream ended mid-frame, not freezing', uri)
                return finish()
            }
            if (!endMarker) {
                dbg('listing stream ended without the final data: marker, not freezing', uri)
                return finish()
            }
            if (!entries.length) {
                dbg('empty listing, not freezing', uri)
                return finish()
            }
            dbg('listing fully read', uri, entries.length, 'entries', bytes, 'bytes; building frozen copy')
            considerSave(uri, account, entries, props)
                .catch(e => dbg('save error', String(e)))
                .finally(finish)
        })
        for (const ev of ['close', 'error'])
            tee.on(ev, () => {
                if (!done) {
                    done = true
                    finish()
                }
            })
    }

    // ---- hooking the request -------------------------------------------------------------

    function isPlainListing(params) {
        if (!params || typeof params !== 'object')
            return false
        const keys = Object.keys(params)
        if (keys.length !== 1 || keys[0] !== 'uri' || typeof params.uri !== 'string')
            return false
        return params.uri !== '/'
    }

    function isSearchListing(params) {
        if (!params || typeof params !== 'object' || typeof params.uri !== 'string')
            return false
        return Boolean(params.search || params.searchComment)
    }

    async function middleware(ctx) {
        try {
            if (!ready)
                return
            if (ctx.path !== API_PATH)
                return
            const params = ctx.state.params || ctx.query
            const searchReq = isSearchListing(params)
            // comments can change after the snapshot was frozen: always let HFS search
            // them natively (current comments, all sub-folders). The dialog can also opt
            // into HFS's own recursive search for names.
            if (searchReq && (params.lcNative || params.searchComment))
                return
            if (!searchReq && !isPlainListing(params)) // filters, sorting requests go to HFS as usual
                return
            const uri = normalizeUri(params.uri)
            const account = userOf(ctx)
            const sse = ctx.get('accept') === 'text/event-stream'
            const rec = index.folders[uri]
            const key = uri + '|' + account
            dbg('request', uri, 'account=' + (account || '-'), 'sse=' + sse,
                'search=' + searchReq, 'indexed=' + Boolean(rec))

            if (searchReq) {
                // HFS's own search UI: stream matches taken from the frozen packets instead
                // of walking the disk, so the dialog, results, paging and stop button stay native
                if (!rec)
                    return
                const meta = await readMeta(rec.dir)
                const known = Boolean(meta && meta.accounts && meta.accounts[account])
                if (!meta || !known)
                    return
                // Every frozen folder is a complete local list; let HFS search natively.
                return
            }

            if (rec) {
                const meta = await readMeta(rec.dir)
                const known = Boolean(meta && meta.accounts && meta.accounts[account])
                if (meta && meta.count > 0 && known) {
                    if (!isStale(meta) || building.has(key)) {
                        if (sse) {
                            serveSse(ctx, uri, rec.dir, meta, account)
                            return
                        }
                        const list = await fullList(rec.dir, meta).catch(() => null)
                        if (list) {
                            try { await overlayComments(uri, list) }
                            catch (e) { /* comments must not break the listing */ }
                            ctx.body = { ...propsFor(meta, account), list }
                            return
                        }
                    }
                    if (!building.has(key))
                        return startCapture(ctx, uri, account)
                    return
                }
            }
            if (building.has(key))
                return
            return startCapture(ctx, uri, account)
        }
        catch (e) {
            dbg('middleware error', String(e && e.stack || e))
        }
    }

    // ---- API used by the page bar --------------------------------------------------------

    async function lc_meta(params, ctx) {
        if (!ready)
            return { frozen: false }
        const uri = normalizeUri(params && params.uri)
        const rec = index.folders[uri]
        const meta = rec && await readMeta(rec.dir)
        if (!meta) {
            const account = userOf(ctx)
            const key = uri + '|' + account
            const progress = captureProgress.get(key)
            return {
                frozen: false,
                building: building.has(key),
                large: Boolean(progress && progress.large)
            }
        }
        const updated = Date.parse(meta.updatedAt) || 0
        if (isInvalid(uri)) {
            const account = userOf(ctx)
            return {
                frozen: false,
                building: building.has(uri + '|' + account),
                large: false
            }
        }
        if (Number(meta.count) <= threshold()) {
            const account = userOf(ctx)
            return {
                frozen: false,
                building: building.has(uri + '|' + account),
                large: false
            }
        }
        return {
            frozen: true,
            count: meta.count,
            pageSize: meta.pageSize,
            bytes: meta.bytes || 0,
            pages: meta.chunks.length,
            updatedAt: meta.updatedAt,
            expires: new Date(updated + maxAge(meta)).toISOString(),
            alphabet: meta.alphabet || {},
            localSort: true,
            dirty: await isDirty(uri),
            sort: meta.sort || { invert: false, numeric: false, foldersFirst: true }
        }
    }

    async function lc_page(params, ctx) {
        if (!ready)
            return { error: 'not ready' }
        const uri = normalizeUri(params && params.uri)
        const rec = index.folders[uri]
        const meta = rec && await readMeta(rec.dir)
        if (!meta)
            return { error: 'not frozen' }
        const account = userOf(ctx)
        if (!meta.accounts || !meta.accounts[account])
            return { error: 'forbidden' }
        const pages = meta.chunks.length
        const page = Math.max(1, Math.min(pages, Math.floor(Number(params && params.page)) || 1))
        try {
            const text = await fsp.readFile(path.join(rec.dir, meta.gen, meta.chunks[page - 1]), 'utf8')
            const entries = []
            for (const op of JSON.parse(text))
                if (Array.isArray(op) && op[0] === '+' && op[1])
                    entries.push(op[1])
            try { await overlayComments(uri, entries) }
            catch (e) { /* comments must not break the page */ }
            return { page, pages, pageSize: meta.pageSize, count: meta.count, entries }
        }
        catch (e) {
            dbg('page read error', uri, page, String(e))
            return { error: 'missing packet' }
        }
    }

    async function lc_all(params, ctx) {
        if (!ready)
            return { error: 'not ready' }
        const uri = normalizeUri(params && params.uri)
        const rec = index.folders[uri]
        const meta = rec && await readMeta(rec.dir)
        if (!meta)
            return { error: 'not frozen' }
        const account = userOf(ctx)
        if (!meta.accounts || !meta.accounts[account])
            return { error: 'forbidden' }
        try {
            const entries = await fullList(rec.dir, meta)
            try { await overlayComments(uri, entries) }
            catch (e) { /* comments must not break the listing */ }
            return {
                count: meta.count,
                pages: meta.chunks.length,
                pageSize: meta.pageSize,
                entries
            }
        }
        catch (e) {
            dbg('all list read error', uri, String(e))
            return { error: 'missing packet' }
        }
    }

    // used by the frontend right after HFS saves a file comment, so the frozen row can be
    // updated without reloading the page
    async function lc_comment(params, ctx) {
        if (!ready)
            return { unavailable: true }
        const uri = String(params && params.uri || '')
        if (!uri)
            return { unavailable: true }
        const clean = uri.replace(/\/+$/, '')
        const parentUri = clean.slice(0, clean.lastIndexOf('/') + 1) || '/'
        const rec = index.folders[normalizeUri(parentUri)]
        const meta = rec && await readMeta(rec.dir)
        const account = userOf(ctx)
        if (!meta || !meta.accounts || !meta.accounts[account])
            return { unavailable: true }
        const full = sourceDirFor(uri)
        if (!full)
            return { unavailable: true }
        const map = await readLiveComments(path.dirname(full))
        if (!map)
            return { unavailable: true }
        return { comment: map.get(path.basename(full)) || '' }
    }

    // used by the frontend right after a file operation; the current page keeps its
    // in-memory listing and the frozen copy is rebuilt in the background
    async function lc_dirty(params, ctx) {
        if (!ready)
            return { error: 'not ready' }
        const uri = normalizeUri(params && params.uri)
        const rec = index.folders[uri]
        const meta = rec && await readMeta(rec.dir)
        const account = userOf(ctx)
        if (!meta || !meta.accounts || !meta.accounts[account])
            return { error: 'forbidden' }
        await markDirty(uri)
        return { ok: true, dirty: true, at: new Date().toISOString() }
    }

    async function lc_invalidate(params, ctx) {
        if (!ready)
            return { error: 'not ready' }
        const uri = normalizeUri(params && params.uri)
        const rec = index.folders[uri]
        const meta = rec && await readMeta(rec.dir)
        const account = userOf(ctx)
        if (!meta || !meta.accounts || !meta.accounts[account])
            return { error: 'forbidden' }
        await markInvalid(uri)
        return { ok: true }
    }

    return { middleware, customRest: { lc_meta, lc_page, lc_all, lc_comment, lc_dirty, lc_invalidate } }
}


