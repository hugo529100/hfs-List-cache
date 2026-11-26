/* List-cache 3.5 — native HFS search and filter, backed by the frozen packets.
 *
 * The listing is served one packet at a time. Normal browsing is lazy: the page bar
 * loads the clicked packet, scrolling near the bottom appends the next one, and
 * scrolling near the top prepends the previous one while keeping the viewport anchored.
 *
 * The header sticker is a separate #lc-stats element. The native #folder-stats is only
 * hidden with CSS, never written to, so moving to a normal folder always restores it.
 *
 * Search and Select/filter keep HFS's own interfaces instead of plugin controls:
 *  - the magnifier opens the native search dialog; the server streams matches taken from
 *    the frozen packets, so the native results, paging and stop button all work as usual;
 *  - Select opens the native filter bar; the first time a filter is typed, the whole
 *    frozen listing is fetched once, then native filtering and native paging take over.
 *
 * Ordering plugins (Fixed-folder-order and any other sortCompare listener) are applied to
 * each loaded packet in the browser, so the frozen database never needs a rebuild just
 * because their rules change; a comment tag change re-sorts its current page immediately.
 */
(function () {
    'use strict'
    const HFS = window.HFS
    if (!HFS || !HFS.state || !HFS.DirEntry || typeof HFS.customRestCall !== 'function'
        || typeof HFS.watchState !== 'function')
        return

    const state = HFS.state
    const originalPageSize = state.page_size
    const BIG_PAGE = 1_000_000_000 // let HFS render the loaded packets as a single page
    const NEAR_PX = 600

    let info = null
    let localEntries = null // complete frozen listing
    let dirtyToastTimer = 0
    let dirtyBreathTimer = 0
    let localFileShowOpen = false
    let localListArray = null // last state.list array written by the local pager
    let localListWrite = false
    const lcAllCache = new Map() // page-session snapshot: lc_all never changes until refresh
    const lcMetaCache = new Map() // page-session metadata: keeps Musicplayer+ on the frozen path

    function setLocalList(list) {
        localListWrite = true
        localListArray = list
        state.list = list
        setTimeout(() => { localListWrite = false }, 0)
    }
    let currentUri = ''
    let forced = { sort_by: 'name', invert_order: false, folders_first: true, sort_numerics: false }
    let pending = null
    let nativeSuspend = false
    let seq = 0
    let activePage = 1
    let loadedFirst = 0
    let loadedLast = 0
    let busy = false
    let filtering = false          // native filter bar is filtering the frozen listing
    let filterLoading = false      // the one-shot full-list request is in flight
    let loadEpoch = 0              // invalidates packet loads that started in another mode
    let pendingNativeDeep = false  // the search dialog asked for the native recursive search
    let suspendedUri = ''          // frozen folder whose search results are being shown
    let reopenSearchToken = 0
    let pagerNode = null
    let lastTop = 0
    let cooldownUntil = 0
    let refreshScheduled = false
    let scrollQueued = false
    let lastActiveAt = 0
    let fillTimer = 0
    const prefetched = new Map() // page -> Promise<lc_page result>, for the pages around the window

    const el = (tag, props = {}, ...kids) => {
        const node = document.createElement(tag)
        for (const k in props) {
            const v = props[k]
            if (v === undefined || v === null)
                continue
            if (k === 'text')
                node.textContent = v
            else if (k === 'class')
                node.className = v
            else if (k === 'onclick')
                node.addEventListener('click', v)
            else
                node.setAttribute(k, String(v))
        }
        for (const kid of kids)
            if (kid)
                node.append(kid)
        return node
    }

    const notify = msg => {
        try { HFS.toast?.(msg) }
        catch (e) { /* older HFS */ }
    }

    const fmt = n => Number(n || 0).toLocaleString()
    function fmtDate(value, withYear) {
        const d = new Date(value)
        if (isNaN(d.getTime()))
            return '-'
        const p = n => String(n).padStart(2, '0')
        const year = withYear ? String(d.getFullYear()).slice(-2) + '-' : ''
        return `${year}${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    function fmtSize(value) {
        const unit = Number(HFS.kb) > 0 ? Number(HFS.kb) : 1000 // same base HFS uses in its own stats
        const n = Number(value) || 0
        if (n < unit)
            return n + ' B'
        const units = ['KB', 'MB', 'GB', 'TB']
        let v = n / unit
        let i = 0
        while (v >= unit && i < units.length - 1) {
            v /= unit
            i++
        }
        return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i]
    }

    const pageSize = () => Math.max(1, Math.floor(Number(info && info.pageSize) || 100))
    const totalPages = () => Math.max(1, Math.floor(Number(info && info.pages) || 1))
    const currentList = () => Array.isArray(state.list) ? state.list : []
    const rows = () => document.querySelectorAll('ul.dir > li')
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const textCollator = new Intl.Collator(undefined, { sensitivity: 'base' })
    const numericCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

    function extensionOfName(name) {
        const base = String(name || '').replace(/\/$/, '')
        const dot = base.lastIndexOf('.')
        return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    }

    function dateValue(value) {
        const t = value instanceof Date ? value.getTime() : Date.parse(value)
        return Number.isFinite(t) ? t : 0
    }

    function compareLocal(a, b, mode) {
        const ao = Number(a && a.order) || 0, bo = Number(b && b.order) || 0
        if (ao !== bo)
            return bo - ao
        if (mode === 'fixed' && typeof HFS.emit === 'function') {
            const custom = HFS.emit('sortCompare', { a, b }).find(Boolean)
            if (custom)
                return custom
        }
        const af = a.isFolder === true || (a.n && a.n.endsWith('/'))
        const bf = b.isFolder === true || (b.n && b.n.endsWith('/'))
        if (state.folders_first && af !== bf)
            return af ? -1 : 1
        const invert = state.invert_order ? -1 : 1
        let r = 0
        if (mode !== 'fixed') {
            const by = state.sort_by
            if (by === 'size')
                r = (Number(a.s) || 0) - (Number(b.s) || 0)
            else if (by === 'extension')
                r = textCollator.compare(a.ext || extensionOfName(a.n), b.ext || extensionOfName(b.n))
            else if (by === 'time')
                r = dateValue(a.m) - dateValue(b.m)
            else if (by === 'creation')
                r = dateValue(a.c) - dateValue(b.c)
        }
        if (!r && state.sort_numerics)
            r = numericCollator.compare(a.n, b.n)
        if (!r)
            r = textCollator.compare(a.n, b.n)
        return invert * r
    }

    function fixedOrderEnabled() {
        try {
            const value = localStorage.getItem('hfs_fixed_folder_order_enabled')
            return value === null || value === 'true'
        }
        catch (e) { return true }
    }

    let localFixedOrder = null
    let localFixedOrderKey = ''
    const localPureOrders = new Map()

    function localPureOrder() {
        const key = [state.sort_by, !!state.invert_order, !!state.folders_first, !!state.sort_numerics].join('|')
        let list = localPureOrders.get(key)
        if (!list) {
            list = [...localEntries].sort((a, b) => compareLocal(a, b, 'pure'))
            localPureOrders.set(key, list)
        }
        return list
    }

    function localOrderForCurrentSort() {
        if (!localEntries)
            return []
        const base = localPureOrder()
        if (!fixedOrderEnabled() || typeof HFS.emit !== 'function')
            return base
        const key = [state.sort_by, !!state.invert_order, !!state.folders_first, !!state.sort_numerics].join('|')
        if (!localFixedOrder || localFixedOrderKey !== key) {
            // Fixed-folder-order has the highest weight; everything it considers equal
            // keeps the already-loaded native list order as the tie-breaker.
            const rank = new Map(base.map((entry, index) => [entry, index]))
            localFixedOrder = [...base].sort((a, b) => {
                const custom = HFS.emit('sortCompare', { a, b }).find(Boolean)
                return custom || (rank.get(a) - rank.get(b))
            })
            localFixedOrderKey = key
        }
        return localFixedOrder
    }

    function clearLocalOrders() {
        localFixedOrder = null
        localFixedOrderKey = ''
        localPureOrders.clear()
    }

    // Videos-player and other local consumers can ask for the exact order currently
    // used by the list (native sort + Fixed-folder-order overlay). Returns null when
    // the folder is not in the first-tier local mode.
    window.__listCacheOrdered = function (uri) {
        if (!info || !info.localSort || !localEntries || !currentUri)
            return null
        try {
            if (decodedPath(sessionKey(uri)) !== decodedPath(sessionKey(currentUri)))
                return null
        }
        catch (e) { return null }
        return localOrderForCurrentSort().slice()
    }

    function sessionKey(uri) {
        let u = String(uri || '/')
        if (!u.startsWith('/'))
            u = '/' + u
        if (!u.endsWith('/'))
            u += '/'
        return u
    }

    function decodedPath(value) {
        try { return decodeURIComponent(value) }
        catch (e) { return String(value) }
    }

    function sessionBase() {
        return sessionKey(currentUri)
    }

    function updateCachedComment(parentUri, fileUri, comment) {
        const cached = lcAllCache.get(sessionKey(parentUri))
        if (!cached || !Array.isArray(cached.entries))
            return
        const target = decodedPath(fileUri)
        const base = sessionKey(parentUri)
        const name = target.slice(target.lastIndexOf('/') + 1)
        for (const entry of cached.entries) {
            if (!entry || entry.n !== name)
                continue
            if (comment)
                entry.comment = comment
            else
                delete entry.comment
            break
        }
    }

    let localExpandTimer = 0
    let fullAssertTimer = 0

    function scheduleFullAssert(uri, tries) {
        clearTimeout(fullAssertTimer)
        let left = tries || 10
        const run = () => {
            if (!info || currentUri !== uri || !localEntries)
                return
            if (!fileShowIsVisible() && !state.loading && !filtering && !state.remoteSearch
                && state.list !== localListArray) {
                restoreLocalFull()
            }
            if (--left > 0)
                fullAssertTimer = setTimeout(run, 250)
        }
        fullAssertTimer = setTimeout(run, 120)
    }

    function restoreLocalFull(scroll) {
        if (!info || !info.localSort || !localEntries)
            return
        const ordered = localOrderForCurrentSort()
        try { state.page_size = Number(info.pageSize) || pageSize() }
        catch (e) { /* ignore */ }
        const list = [...ordered]
        localListWrite = true
        localListArray = list
        state.list = list
        setTimeout(() => { localListWrite = false }, 0)
        info.count = ordered.length
        info.pages = Math.max(1, Math.ceil(ordered.length / (Number(info.pageSize) || pageSize())))
        buildPager()
        if (scroll)
            window.scrollTo({ top: 0 })
    }

    function renderLocalPage(page, scroll) {
        // Native HFS paging: never replace the complete list with one page slice.
        restoreLocalFull(scroll)
    }

    function scheduleLocalExpand() {
        if (!info || !info.localSort || !localEntries)
            return
        clearLocalOrders()
        clearTimeout(localExpandTimer)
        localExpandTimer = setTimeout(() => {
            renderLocalPage(1)
            // HFS may sort/trim its own copy once more after its debounced sort
            setTimeout(() => renderLocalPage(1), 180)
        }, 120)
    }

    function forceSort() {
        for (const k in forced)
            if (state[k] !== forced[k])
                state[k] = forced[k]
    }

    // ---- header sticker (never touches the native #folder-stats) -------------------------

    function headerText() {
        const from = new Date(info.updatedAt)
        const to = new Date(info.expires)
        // only add the 2-digit year when the validity actually crosses a year boundary
        const crossYear = !isNaN(from.getTime()) && !isNaN(to.getTime())
            && from.getFullYear() !== to.getFullYear()
        if (info.dirty)
            return 'Changes detected - Folder menu > Rebuild Frolist or double click'
        const mode = 'Frozen list mode'
        return `${mode} | FRO:${fmtDate(info.updatedAt, crossYear)} / EXP:${fmtDate(info.expires, crossYear)} | ${fmt(info.count)} items / size: ${fmtSize(info.bytes)}`
    }

    function syncHeaderHeight() {
        let h = 34
        const btn = document.querySelector('#menu-bar button')
        if (btn) {
            const r = btn.getBoundingClientRect().height
            if (r > 16)
                h = Math.round(r)
        }
        document.body.style.setProperty('--lc-header-btn-h', h + 'px')
    }

    function syncHeaderShare() {
        if (!info)
            return
        const sticker = document.getElementById('lc-stats')
        const header = document.querySelector('header')
        if (!sticker || !header) {
            document.body.classList.remove('lc-header-share')
            return
        }
        const crumbs = [...header.querySelectorAll('.breadcrumb')]
        if (!crumbs.length) {
            document.body.classList.remove('lc-header-share')
            return
        }
        const last = crumbs[crumbs.length - 1].getBoundingClientRect()
        const hr = header.getBoundingClientRect()
        const clone = sticker.cloneNode(true)
        clone.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;width:max-content;max-width:none;'
        document.body.append(clone)
        const needed = Math.ceil(clone.getBoundingClientRect().width) + 18
        clone.remove()
        const available = Math.floor(hr.right - last.right - 12)
        document.body.classList.toggle('lc-header-share', available >= needed)
    }

    function addFolderMenuRebuild() {
        if (!window.HFS || typeof HFS.onEvent !== 'function')
            return
        HFS.onEvent('fileMenu', ({ entry, menu }) => {
            if (!info || !entry || !entry.isFolder || !Array.isArray(menu))
                return
            if (menu.some(item => item && item.id === 'lc-rebuild'))
                return
            const item = {
                id: 'lc-rebuild',
                icon: 'reload',
                label: 'Rebuild Frolist',
                onClick() {
                    forceRebuildFrozen()
                }
            }
            const at = menu.findIndex(item => item && item.id === 'reload')
            if (at >= 0)
                menu.splice(at, 0, item)
            else
                menu.push(item)
        })
    }
    addFolderMenuRebuild()

    async function forceRebuildFrozen() {
        if (!info || !currentUri)
            return
        let ok = true
        try {
            if (HFS.dialogLib && HFS.dialogLib.confirmDialog)
                ok = await HFS.dialogLib.confirmDialog('Rebuild frozen list',
                    'Rebuild only "' + decodedPath(currentUri) + '"? Other frozen folders stay untouched.')
        }
        catch (e) { ok = false }
        if (!ok)
            return
        const uri = currentUri
        const previous = info.updatedAt
        try {
            const res = await HFS.customRestCall('lc_invalidate', { uri })
            if (!res || res.error) {
                notify('Could not start the frozen-list rebuild')
                return
            }
        }
        catch (e) {
            notify('Could not start the frozen-list rebuild')
            return
        }
        lcAllCache.delete(sessionKey(uri))
        lcMetaCache.delete(sessionKey(uri))
        info.dirty = true
        ensureSticker()
        notify('Rebuilding frozen list…')
        try { HFS.reloadList() }
        catch (e) { /* next listing request will rebuild */ }
        const started = Date.now()
        const timer = setInterval(async () => {
            if (!info || currentUri !== uri) {
                clearInterval(timer)
                return
            }
            let meta = null
            try {
                const res = await fetch('/~/api/_lc_meta', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-hfs-anti-csrf': '1'
                    },
                    body: JSON.stringify({ uri })
                })
                if (res.ok)
                    meta = await res.json()
            }
            catch (e) { /* keep polling */ }
            if (meta && meta.frozen && meta.updatedAt && meta.updatedAt !== previous) {
                clearInterval(timer)
                notify('Frozen list rebuilt')
                setTimeout(() => location.reload(), 180)
            }
            else if (Date.now() - started > 120000) {
                clearInterval(timer)
                notify('Rebuild is taking longer than expected; refresh the page later')
            }
        }, 1000)
    }

    function bindStickerDoubleClick(node) {
        if (!node || node.__lcDoubleClickBound)
            return
        node.__lcDoubleClickBound = true
        let lastTap = 0
        let lastTrigger = 0
        const trigger = ev => {
            if (ev) {
                ev.preventDefault()
                ev.stopPropagation()
                ev.stopImmediatePropagation()
            }
            const now = Date.now()
            if (now - lastTrigger < 1200)
                return
            lastTrigger = now
            forceRebuildFrozen()
        }
        node.addEventListener('dblclick', trigger)
        node.addEventListener('touchend', ev => {
            if (ev.changedTouches.length !== 1)
                return
            const now = Date.now()
            if (now - lastTap < 400) {
                lastTap = 0
                trigger(ev)
            }
            else {
                lastTap = now
                setTimeout(() => {
                    if (Date.now() - lastTap >= 400)
                        lastTap = 0
                }, 500)
            }
        }, { passive: false })
        node.addEventListener('contextmenu', ev => {
            ev.preventDefault()
            ev.stopPropagation()
            ev.stopImmediatePropagation()
        })
    }

    function syncDirtyBreathing(node) {
        if (!node)
            return
        if (!info || !info.dirty) {
            clearInterval(dirtyBreathTimer)
            dirtyBreathTimer = 0
            node.style.opacity = ''
            return
        }
        if (dirtyBreathTimer)
            return
        const started = Date.now()
        dirtyBreathTimer = setInterval(() => {
            const el = document.getElementById('lc-stats')
            if (!el || !info || !info.dirty)
                return
            const phase = (Date.now() - started) / 2600 * Math.PI * 2
            el.style.opacity = (0.42 + 0.58 * (0.5 + 0.5 * Math.sin(phase))).toFixed(3)
        }, 60)
    }

    function ensureSticker() {
        if (!info)
            return null
        let node = document.getElementById('lc-stats')
        if (!node) {
            const header = document.querySelector('header')
            if (!header)
                return null
            node = el('div', { id: 'lc-stats' })
            const native = header.querySelector('#folder-stats')
            if (native && native.parentNode === header)
                header.insertBefore(node, native)
            else
                header.append(node)
        }
        const text = headerText()
        node.classList.toggle('lc-dirty-flash', !!info.dirty)
        syncDirtyBreathing(node)
        if (node.textContent !== text)
            node.textContent = text
        node.title = 'Double-click or double-tap to force a rebuild of the frozen listing'
        bindStickerDoubleClick(node)
        syncHeaderHeight()
        requestAnimationFrame(syncHeaderShare)
        return node
    }

    function removeSticker() {
        const node = document.getElementById('lc-stats')
        if (node)
            node.remove()
    }

    // ---- page bar (normal lazy browsing) -------------------------------------------------

    function pageLabel(page, shrink) {
        const offset = (page - 1) * pageSize()
        return shrink && (page - 1) % 10 === 0 && offset >= 1000
            ? (offset / 1000) + 'K'
            : String(offset)
    }

    function arrowButton(icon, title, disabled, onclick) {
        const b = el('button', {
            title,
            class: disabled ? 'toggled' : undefined,
            onclick
        })
        b.append(el('span', { 'aria-hidden': 'true', role: 'img', class: ' icon font-icon fa-' + icon }))
        return b
    }

    function barParent() {
        return document.querySelector('.bottom-bar-stack-positioner')
            || document.querySelector('.bottom-bar-stack')
            || document.body
    }

    function mountPager() {
        if (!pagerNode || filtering)
            return
        const parent = barParent()
        if (pagerNode.parentNode !== parent)
            parent.prepend(pagerNode)
        requestAnimationFrame(focusPagerButton)
    }

    // Keep the highlighted page inside the visible part of the horizontally scrolling
    // middle strip. Only recenter when it is outside the comfortable middle area, so normal
    // scrolling does not constantly move the bar.
    function focusPagerButton() {
        const middle = document.getElementById('lc-paging-middle')
        if (!middle)
            return
        const active = middle.querySelector('button.toggled')
        if (!active)
            return
        const mr = middle.getBoundingClientRect()
        const ar = active.getBoundingClientRect()
        const pad = Math.min(48, Math.max(12, middle.clientWidth * 0.12))
        if (ar.left >= mr.left + pad && ar.right <= mr.right - pad)
            return
        const max = middle.scrollWidth - middle.clientWidth
        if (max <= 0)
            return
        let target = middle.scrollLeft + (ar.left - mr.left) - (middle.clientWidth - ar.width) / 2
        target = Math.max(0, Math.min(max, target))
        if (Math.abs(target - middle.scrollLeft) < 1)
            return
        // instant, not smooth: a smooth animation on every packet during finger scrolling
        // makes the bar visibly race left/right on touch devices
        middle.scrollLeft = target
    }

    function updatePagerActive(page) {
        if (!pagerNode)
            return
        const pages = Number(pagerNode.dataset.pages) || totalPages()
        pagerNode.dataset.current = String(page)
        const current = page - 1
        const middle = pagerNode.querySelector('#lc-paging-middle')
        if (middle)
            for (const button of middle.children)
                button.classList.toggle('toggled', Number(button.dataset.page) === current)
        const arrows = [...pagerNode.children].filter(node => node.tagName === 'BUTTON')
        if (arrows[0])
            arrows[0].classList.toggle('toggled', page === 1)
        if (arrows[1])
            arrows[1].classList.toggle('toggled', page === pages)
        if (page === 1 && middle)
            middle.scrollLeft = 0 // page 1 has no middle button; show the start of the strip
    }

    function removePager() {
        if (pagerNode) {
            pagerNode.remove()
            pagerNode = null
        }
        const stray = document.getElementById('lc-paging')
        if (stray)
            stray.remove()
    }

    function buildPager() {
        if (!info || filtering) {
            removePager()
            return
        }
        const pages = totalPages()
        const currentPage = Math.max(1, Math.min(pages, activePage || 1))
        const current = currentPage - 1
        const shrink = pages > 20
        const from = Math.floor(current / 10) * 10
        const to = from + 10
        const windowKey = `${pages}|${shrink ? from + '-' + to : 'all'}`
        // While scrolling through pages inside the same label window, only move the
        // highlight; recreating the pager reset its horizontal scroll on every packet.
        if (pagerNode && pagerNode.dataset.pages === String(pages)
            && pagerNode.dataset.window === windowKey) {
            updatePagerActive(currentPage)
            mountPager()
            return
        }
        removePager()
        const middle = el('div', { id: 'lc-paging-middle' })
        for (let i = 1; i < pages; i++) {
            if (shrink && i % 10 && (i < from || i >= to))
                continue
            middle.append(el('button', {
                'data-page': String(i),
                class: i === current ? 'toggled' : undefined,
                text: pageLabel(i + 1, shrink),
                onclick: () => { if (i !== current) gotoPage(i + 1) }
            }))
        }
        pagerNode = el('div', {
            id: 'lc-paging',
            'data-pages': String(pages),
            'data-current': String(currentPage),
            'data-window': windowKey
        },
            arrowButton('to_start', 'Go to first item', currentPage === 1, () => { if (activePage !== 1) gotoPage(1) }),
            middle,
            arrowButton('to_end', 'Go to last item', currentPage === pages, () => { if (activePage !== pages) gotoPage(pages) })
        )
        mountPager()
    }

    // ---- native filter bar over the frozen listing ---------------------------------------

    function filterWanted() {
        return Boolean(info) && state.showFilter === true
            && String(state.patternFilter || '').trim() !== ''
    }

    function syncFilterMode() {
        if (!info || info.localSort)
            return
        if (filterWanted())
            enterFiltering()
        else
            leaveFiltering()
    }

    function enterFiltering() {
        if (!info || filtering)
            return
        filtering = true
        loadEpoch++
        prefetched.clear()
        document.body.classList.add('lc-filtering')
        removePager()
        if (info.localSort) {
            // first tier: the complete list is already in memory; native filter + paging
            try { state.page_size = info.pageSize } catch (e) { /* ignore */ }
            clearLocalOrders()
            state.list = [...localOrderForCurrentSort()]
            loadedFirst = 1
            loadedLast = totalPages()
            activePage = 1
            return
        }
        // native paging over the filtered result, exactly like a normal folder
        try { state.page_size = originalPageSize }
        catch (e) { /* ignore */ }
        forceSort()
        loadAllForFilter()
    }

    function leaveFiltering() {
        if (!filtering)
            return
        filtering = false
        loadEpoch++
        prefetched.clear()
        document.body.classList.remove('lc-filtering')
        if (filterLoading) {
            filterLoading = false
            try { state.loading = false }
            catch (e) { /* ignore */ }
        }
        if (!info)
            return
        if (info.localSort) {
            clearLocalOrders()
            try { state.page_size = info.pageSize } catch (e) { /* ignore */ }
            loadedFirst = loadedLast = 1
            activePage = 1
            state.list = [...localOrderForCurrentSort()]
            window.scrollTo({ top: 0 })
            return
        }
        // the filter may have widened the window to the whole listing: go back to one packet
        const keep = pageSize()
        if (currentList().length > keep)
            state.list = currentList().slice(0, keep)
        loadedLast = Math.max(1, loadedFirst || 1)
        activePage = loadedLast
        try { state.page_size = BIG_PAGE }
        catch (e) { /* ignore */ }
        buildPager()
        mountPager()
        window.scrollTo({ top: 0 })
    }

    async function loadAllForFilter() {
        if (!info || !filtering)
            return
        if (loadedFirst === 1 && loadedLast >= totalPages()
            && currentList().length >= Number(info.count))
            return // the whole listing is already in memory
        const my = seq
        const epoch = loadEpoch
        const uri = currentUri
        let res = null
        try {
            state.loading = true
            filterLoading = true
        }
        catch (e) { /* ignore */ }
        try { res = await HFS.customRestCall('lc_all', { uri }) }
        catch (e) { /* offline */ }
        if (my === seq && epoch === loadEpoch) {
            filterLoading = false
            try { state.loading = false }
            catch (e) { /* ignore */ }
        }
        if (my !== seq || epoch !== loadEpoch || !info || !filtering || uri !== currentUri)
            return
        if (!res || res.error || !Array.isArray(res.entries)) {
            notify('Could not read the whole frozen list for filtering')
            return
        }
        state.list = toEntries(res.entries, false)
        loadedFirst = 1
        loadedLast = totalPages()
        activePage = 1
    }

    // ---- serving the frozen packets ------------------------------------------------------

    // apply other plugins' sortCompare (Fixed-folder-order, ...) to the entries of this
    // loaded packet only; the frozen database keeps its stable name order
    function sortPage(entries) {
        if (!Array.isArray(entries) || entries.length < 2 || typeof HFS.emit !== 'function')
            return entries
        try {
            return entries.sort((a, b) => {
                const custom = HFS.emit('sortCompare', { a, b }).find(Boolean)
                return custom || 0
            })
        }
        catch (e) { return entries }
    }

    // re-sort only the packet that contains the edited entry, so a comment tag change can
    // move the row within the current page without touching the database
    function resortPageContaining(entry) {
        const size = pageSize()
        const list = currentList()
        const idx = list.indexOf(entry)
        if (idx < 0) {
            state.list = [...list]
            return
        }
        const start = Math.floor(idx / size) * size
        const group = list.slice(start, start + size)
        const sorted = sortPage(group.slice())
        if (sorted.some((e, i) => e !== group[i])) {
            const out = list.slice()
            out.splice(start, group.length, ...sorted)
            state.list = out
        }
        else
            state.list = [...list]
    }

    function toEntries(list, applyOrder = true) {
        const out = []
        for (const entry of list || []) {
            if (!entry || typeof entry.n !== 'string')
                continue
            if (entry instanceof HFS.DirEntry) {
                out.push(entry)
                continue
            }
            try { out.push(new HFS.DirEntry(entry.n, entry)) }
            catch (e) { /* skip broken entry */ }
        }
        return applyOrder && !(info && info.localSort) ? sortPage(out) : out
    }

    async function fetchPageData(page, uri, my) {
        try {
            const res = await HFS.customRestCall('lc_page', { uri, page })
            if (my !== seq || !res || res.error || !Array.isArray(res.entries))
                return null
            return res
        }
        catch (e) { return null }
    }

    async function fetchPage(page) {
        if (info && info.localSort && localEntries) {
            const size = pageSize()
            const ordered = localOrderForCurrentSort()
            const pages = Math.max(1, Math.ceil(ordered.length / size))
            const p = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1))
            return {
                page: p,
                pages,
                pageSize: size,
                count: ordered.length,
                entries: ordered.slice((p - 1) * size, p * size)
            }
        }
        if (busy)
            return null
        const uri = currentUri
        const my = seq
        busy = true
        try {
            const pending = prefetched.get(page)
            if (pending)
                prefetched.delete(page)
            return pending ? await pending : await fetchPageData(page, uri, my)
        }
        finally { if (my === seq) busy = false }
    }

    // Fill the two pages around the loaded window in the background. They are only small
    // JSON responses and make the next scroll step (especially with touch momentum) start
    // from memory instead of waiting for the request.
    function prefetchPage(page) {
        if (!info || info.localSort || filtering || page < 1 || page > totalPages())
            return
        if (page >= loadedFirst && page <= loadedLast)
            return
        if (prefetched.has(page))
            return
        const task = fetchPageData(page, currentUri, seq)
        prefetched.set(page, task)
        task.then(res => {
            if (!res && prefetched.get(page) === task)
                prefetched.delete(page)
        })
    }

    function prefetchNeighbors() {
        if (!info || filtering)
            return
        prefetchPage(loadedLast + 1)
        prefetchPage(loadedFirst - 1)
        for (const page of [...prefetched.keys()])
            if (page < loadedFirst - 2 || page > loadedLast + 2)
                prefetched.delete(page)
    }

    async function appendNextPage() {
        if (!info || filtering || busy || loadedLast >= totalPages())
            return false
        const epoch = loadEpoch
        const page = loadedLast + 1
        const res = await fetchPage(page)
        if (epoch !== loadEpoch || !info || filtering)
            return false
        if (!res)
            return false
        setLocalList([...currentList(), ...toEntries(res.entries)])
        loadedLast = page
        prefetchNeighbors()
        await nextFrame()
        return true
    }

    function scheduleFill() {
        clearTimeout(fillTimer)
        fillTimer = setTimeout(() => {
            if (!info || info.localSort || filtering || busy)
                return
            if (loadedLast < totalPages() && nearBottom())
                loadNextPage()
        }, 120)
    }

    async function loadNextPage() {
        if (!info || filtering || busy || loadedLast >= totalPages())
            return false
        const ok = await appendNextPage()
        if (!ok)
            return false
        cooldownUntil = Date.now() + 250
        refreshActive()
        if (nearBottom())
            scheduleFill()
        return true
    }

    function nextRender(prevCount) {
        return new Promise(resolve => {
            let frames = 0
            const tick = () => {
                if (rows().length !== prevCount || ++frames > 30)
                    requestAnimationFrame(() => resolve())
                else
                    requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
        })
    }

    async function loadPrevPage() {
        if (!info || filtering || busy || loadedFirst <= 1)
            return false
        const epoch = loadEpoch
        const page = loadedFirst - 1
        const res = await fetchPage(page)
        if (epoch !== loadEpoch || !info || filtering)
            return false
        if (!res)
            return false
        // measure only now: the user may have scrolled while the packet was loading
        const first = rows()[0]
        const beforeTop = first ? first.getBoundingClientRect().top : null
        const beforeCount = rows().length
        setLocalList([...toEntries(res.entries), ...currentList()])
        loadedFirst = page
        if (first && first.isConnected) {
            await nextRender(beforeCount)
            const afterTop = first.getBoundingClientRect().top
            if (Number.isFinite(beforeTop) && Number.isFinite(afterTop))
                window.scrollBy(0, afterTop - beforeTop)
        }
        cooldownUntil = Date.now() + 400
        refreshActive(true)
        prefetchNeighbors()
        return true
    }

    function scrollToPage(page) {
        const list = rows()
        if (!list.length)
            return
        const idx = Math.max(0, (page - loadedFirst) * pageSize())
        const li = list[Math.min(idx, list.length - 1)]
        if (!li)
            return
        try { li.scrollIntoView({ block: 'center' }) }
        catch (e) { li.scrollIntoView(true) }
    }

    async function gotoPage(page, opts = {}) {
        if (!info || filtering)
            return false
        const pages = totalPages()
        page = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1))
        if (!opts.force && page >= loadedFirst && page <= loadedLast) {
            activePage = page
            buildPager()
            scrollToPage(page)
            return true
        }
        if (busy)
            return false
        const epoch = loadEpoch
        const res = await fetchPage(page)
        if (epoch !== loadEpoch || !info || filtering)
            return false
        if (!res)
            return false
        state.list = toEntries(res.entries)
        loadedFirst = loadedLast = page
        activePage = page
        buildPager()
        prefetchNeighbors()
        window.scrollTo({ top: 0 })
        cooldownUntil = Date.now() + 400
        return true
    }

    // ---- scroll handling -----------------------------------------------------------------

    function computeActivePage() {
        if (!info)
            return 1
        const list = rows()
        if (!list.length)
            return 1
        const mid = window.innerHeight / 2
        let idx = -1
        const hit = document.elementFromPoint(window.innerWidth / 2, mid)
        const li = hit && hit.closest ? hit.closest('ul.dir > li') : null
        if (li)
            idx = Array.prototype.indexOf.call(list, li)
        if (idx < 0) {
            for (let i = 0; i < list.length; i++) {
                if (list[i].getBoundingClientRect().top <= mid)
                    idx = i
                else
                    break
            }
        }
        return Math.max(1, Math.min(totalPages(), loadedFirst + Math.floor(Math.max(0, idx) / pageSize())))
    }

    function refreshActive(force) {
        if (!info || info.localSort || filtering)
            return
        const now = Date.now()
        if (!force && now - lastActiveAt < 150)
            return
        lastActiveAt = now
        const page = computeActivePage()
        if (page !== activePage) {
            activePage = page
            buildPager()
        }
    }

    function nearBottom() {
        const doc = document.scrollingElement || document.documentElement
        if (!doc)
            return true
        const max = doc.scrollHeight - window.innerHeight
        if (max <= NEAR_PX)
            return true
        const top = window.scrollY || doc.scrollTop || 0
        return top >= max - Math.max(NEAR_PX, window.innerHeight * 2.2)
    }

    function processScroll() {
        if (!info || info.localSort || filtering)
            return
        const doc = document.scrollingElement || document.documentElement
        if (!doc)
            return
        const top = window.scrollY || doc.scrollTop || 0
        const down = top > lastTop
        lastTop = top
        refreshActive()
        if (busy || Date.now() < cooldownUntil)
            return
        const max = doc.scrollHeight - window.innerHeight
        const margin = Math.max(NEAR_PX, Math.round(window.innerHeight * 2.2))
        if (max <= 80) {
            if (loadedLast < totalPages())
                loadNextPage()
            return
        }
        if (down && top >= max - margin)
            loadNextPage()
        else if (!down && top <= Math.max(300, Math.round(window.innerHeight * 1.2)) && loadedFirst > 1)
            loadPrevPage()
    }

    window.addEventListener('scroll', () => {
        if (!info || info.localSort || filtering || scrollQueued)
            return
        scrollQueued = true
        requestAnimationFrame(() => {
            scrollQueued = false
            processScroll()
        })
    }, { passive: true })

    // at the very top there is no further scroll event, so a wheel-up loads the previous
    // packet while keeping the visible row in place
    window.addEventListener('wheel', ev => {
        if (!info || info.localSort || filtering || busy || ev.deltaY >= 0 || Date.now() < cooldownUntil)
            return
        const doc = document.scrollingElement || document.documentElement
        if (!doc || (window.scrollY || doc.scrollTop || 0) > 2 || loadedFirst <= 1)
            return
        loadPrevPage()
    }, { passive: true })

    window.addEventListener('resize', () => {
        if (!info)
            return
        requestAnimationFrame(syncHeaderShare)
        if (filtering || info.localSort)
            return
        requestAnimationFrame(focusPagerButton)
    }, { passive: true })

    // ---- entering / leaving a frozen folder ----------------------------------------------

    function deactivate() {
        seq++
        loadEpoch++
        clearTimeout(dirtyToastTimer)
        clearTimeout(fullAssertTimer)
        clearInterval(dirtyBreathTimer)
        dirtyBreathTimer = 0
        removePager()
        removeSticker()
        info = null
        localEntries = null
        localFileShowOpen = false
        clearLocalOrders()
        currentUri = ''
        pending = null
        activePage = 1
        loadedFirst = loadedLast = 0
        busy = false
        filtering = false
        prefetched.clear()
        clearTimeout(fillTimer)
        if (filterLoading) {
            filterLoading = false
            try { state.loading = false }
            catch (e) { /* ignore */ }
        }
        document.body.classList.remove('lc-frozen')
        document.body.classList.remove('lc-localsort')
        document.body.classList.remove('lc-filtering')
        document.body.classList.remove('lc-header-share')
        if (originalPageSize !== undefined && state.page_size !== originalPageSize) {
            try { state.page_size = originalPageSize }
            catch (e) { /* ignore */ }
        }
    }

    async function loadFirstPage() {
        if (!info)
            return false
        const epoch = loadEpoch
        const res = await fetchPage(1)
        if (epoch !== loadEpoch || filtering)
            return false
        if (!res) {
            loadedFirst = loadedLast = 1
            return false
        }
        state.list = toEntries(res.entries)
        loadedFirst = loadedLast = 1
        activePage = 1
        prefetchNeighbors()
        return true
    }

    async function activateLocalSort(p) {
        if (p.my !== seq)
            return
        info = p.info
        info.dirty = !!(p.dirty || p.info.dirty || readFrozenDirty(p.uri, p.info.updatedAt))
        currentUri = p.uri
        activePage = 1
        loadedFirst = loadedLast = 0
        document.body.classList.add('lc-frozen', 'lc-localsort')
        document.body.classList.remove('lc-filtering')
        removePager()
        ensureSticker()
        let res = null
        try { res = await HFS.customRestCall('lc_all', { uri: p.uri }) }
        catch (e) { /* offline */ }
        if (p.my !== seq || !info)
            return
        if (!res || res.error || !Array.isArray(res.entries)) {
            notify('Could not read the frozen list for local sorting')
            return
        }
        localEntries = toEntries(res.entries, false)
        clearLocalOrders()
        info.count = localEntries.length
        info.bytes = Number(res.bytes) || info.bytes
        info.pageSize = Number(info.pageSize) || pageSize()
        restoreLocalFull()
        ensureSticker()
        scheduleRefresh()
        syncFilterMode()
        syncLocalFileShow()
        scheduleFullAssert(p.uri, 16)
    }

    async function activate(p) {
        // Page-session pin: while this document stays open, keep the list it already has.
        // A background rebuild becomes visible only after a real page refresh.
        if (info && currentUri === p.uri && info.localSort && localEntries) {
            info.dirty = info.dirty || p.info.dirty
            ensureSticker()
            // HFS.reloadList() may replace state.list with its own freshly fetched copy;
            // put the page-session slice back so the visible list stays unchanged.
            setTimeout(() => {
                if (info && currentUri === p.uri && info.localSort && localEntries) {
                    renderLocalPage(activePage)
                    scheduleFullAssert(p.uri, 8)
                }
            }, 80)
            return
        }
        if (p.info.localSort)
            return activateLocalSort(p)
        info = p.info
        info.dirty = !!(p.dirty || p.info.dirty || readFrozenDirty(p.uri, p.info.updatedAt))
        currentUri = p.uri
        activePage = 1
        loadedFirst = loadedLast = 0
        document.body.classList.add('lc-frozen')
        try { state.page_size = BIG_PAGE }
        catch (e) { /* ignore */ }
        forceSort()
        ensureSticker()
        buildPager()
        const my = seq
        await loadFirstPage()
        if (my !== seq)
            return
        ensureSticker()
        buildPager()
        mountPager()
        scheduleRefresh()
        // a native filter may still be open (eg. coming back from a search)
        syncFilterMode()
        let wanted = 0
        try { wanted = Math.floor(Number(new URLSearchParams(location.search).get('lcpage')) || 0) }
        catch (e) { /* ignore */ }
        if (wanted > 1 && !filtering)
            gotoPage(Math.min(totalPages(), wanted))
    }

    function maybeActivate() {
        const p = pending
        if (!p || p.my !== seq)
            return
        if (state.remoteSearch)
            return
        if (state.loading)
            return
        if (state.uri && state.uri !== p.uri) {
            // A fast folder switch can leave HFS's uri one tick behind. Keep the
            // pending activation instead of forgetting it; retry until HFS catches up.
            p.uriWait = (p.uriWait || 0) + 1
            if (p.uriWait > 100) {
                pending = null
                return
            }
            setTimeout(() => {
                if (pending === p && p.my === seq)
                    maybeActivate()
            }, 100)
            return
        }
        pending = null
        activate(p)
    }

    const firstBuildHinted = new Set()

    function showFirstBuildHint(uri) {
        if (firstBuildHinted.has(uri))
            return
        firstBuildHinted.add(uri)
        notify('First visit: building the frozen list. The next visit will open instantly.')
    }

    // A folder with no frozen copy is being learned by the next plain listing. Use the
    // lc_meta response already in hand, plus at most one short retry (the capture may start
    // just after that response). Never poll continuously.
    function maybeHintFirstBuild(res, uri, my) {
        if (my !== seq || !res || res.frozen)
            return
        if (res.building && res.large) {
            showFirstBuildHint(uri)
            return
        }
        setTimeout(() => {
            if (my !== seq)
                return
            HFS.customRestCall('lc_meta', { uri }).then(next => {
                if (my !== seq || !next || next.frozen)
                    return
                if (next.building && next.large)
                    showFirstBuildHint(uri)
            }).catch(() => { /* offline */ })
        }, 1500)
    }

    function onUri(value) {
        deactivate()
        const uri = typeof value === 'string' ? value : ''
        if (!uri.endsWith('/'))
            return
        const my = ++seq
        HFS.customRestCall('lc_meta', { uri }).then(res => {
            if (my !== seq)
                return
            if (!res || !res.frozen) {
                maybeHintFirstBuild(res, uri, my)
                return
            }
            if (!res.localSort && !(Number(res.pages) > 1))
                return
            pending = { uri, info: res, my }
            maybeActivate()
        }).catch(() => { /* offline */ })
    }

    function suspendForNativeSearch() {
        if (info || filtering) {
            nativeSuspend = true
            suspendedUri = currentUri
            deactivate()
        }
    }

    // ---- wiring --------------------------------------------------------------------------

    // Install the page-session cache before the first onUri call, so the initial
    // lc_meta/lc_all responses are pinned as well.
    if (typeof HFS !== 'undefined' && typeof HFS.customRestCall === 'function' && !HFS.__lcSessionAll) {
        const nativeCustomRest = HFS.customRestCall.bind(HFS)
        HFS.customRestCall = function (name, params, ...rest) {
            if (name === 'lc_meta' && params && typeof params.uri === 'string') {
                const key = sessionKey(params.uri)
                if (lcMetaCache.has(key))
                    return Promise.resolve(lcMetaCache.get(key))
                return nativeCustomRest(name, params, ...rest).then(res => {
                    if (res && !res.error)
                        lcMetaCache.set(key, res)
                    return res
                })
            }
            if (name === 'lc_all' && params && typeof params.uri === 'string') {
                const key = sessionKey(params.uri)
                if (lcAllCache.has(key))
                    return Promise.resolve(lcAllCache.get(key))
                return nativeCustomRest(name, params, ...rest).then(res => {
                    if (res && !res.error && Array.isArray(res.entries))
                        lcAllCache.set(key, res)
                    return res
                })
            }
            return nativeCustomRest(name, params, ...rest)
        }
        HFS.__lcSessionAll = true
    }

    HFS.watchState('uri', onUri, true)
    HFS.watchState('loading', value => {
        if (!value)
            maybeActivate()
    })
    HFS.watchState('remoteSearch', value => {
        if (value) {
            if (pendingNativeDeep) {
                pendingNativeDeep = false
                if (!value.lcNative) {
                    // add the flag before the listing effect runs, so HFS asks its own
                    // recursive search instead of the frozen-list one
                    try {
                        state.remoteSearch = { ...value, lcNative: '1' }
                        return
                    }
                    catch (e) { /* fall back to frozen search */ }
                }
            }
            suspendForNativeSearch()
            return
        }
        pendingNativeDeep = false
        if (!nativeSuspend)
            return
        nativeSuspend = false
        suspendedUri = ''
        const uri = state.uri
        if (uri)
            setTimeout(() => onUri(uri), 150)
    })
    for (const key of ['patternFilter', 'showFilter'])
        HFS.watchState(key, () => syncFilterMode())

    // HFS.reloadList() bypasses the normal activation path and can replace state.list
    // with a freshly fetched full listing. Restore the pinned page slice.
    HFS.watchState('list', () => {
        if (!info || !info.localSort || !localEntries || localFileShowOpen)
            return
        if (localListWrite) {
            // HFS may assign its own list synchronously while our write flag is
            // still set. Re-check shortly instead of leaving the page on 50 rows.
            setTimeout(() => {
                if (info && currentUri && localEntries && !localFileShowOpen
                    && !filtering && !fileShowIsVisible() && state.list !== localListArray)
                    restoreLocalFull()
            }, 50)
            return
        }
        if (state.list === localListArray)
            return
        renderLocalPage(activePage)
    })

    for (const k in forced)
        HFS.watchState(k, () => {
            if (!info)
                return
            if (info.localSort) {
                if (!filtering)
                    scheduleLocalExpand()
                return
            }
            if (state[k] === forced[k])
                return
            state[k] = forced[k]
            notify('Sorting is disabled in frozen listings')
        })

    // the sort controls stay visible but are fully blocked, with an explanation
    const SORT_CONTROLS = '#option-sort-by, #option-invert-order, #option-folders-first, #option-sort-numerics'
    function blockSort(ev) {
        if (!info || info.localSort)
            return
        const target = ev.target
        if (!target || !target.closest || !target.closest(SORT_CONTROLS))
            return
        ev.preventDefault()
        ev.stopPropagation()
        notify('Sorting is disabled in frozen listings')
        forceSort()
        if (target.tagName === 'SELECT')
            target.value = forced.sort_by
        else if (target.type === 'checkbox') {
            target.checked = target.id === 'option-invert-order' ? forced.invert_order
                : target.id === 'option-folders-first' ? forced.folders_first
                    : forced.sort_numerics
        }
    }
    document.addEventListener('click', blockSort, true)
    document.addEventListener('change', blockSort, true)

    // ---- note + opt-in native deep search in HFS's own search dialog ----------------------

    function enhanceSearchDialog() {
        if (!info)
            return
        const dialog = document.getElementById('search-dialog')
        if (!dialog)
            return
        const form = dialog.querySelector('form')
        if (!form || form.querySelector('#lc-native-deep'))
            return
        const field = el('div', { class: 'field lc-native-deep', style: 'margin-top:.7em' })
        const label = el('label', { style: 'display:flex;align-items:flex-start;gap:.45em;cursor:pointer' })
        const box = el('input', { type: 'checkbox', id: 'lc-native-deep', style: 'margin-top:.25em' })
        const text = el('span', {}, 'Native deep search: all sub-folders')
        label.append(box, text)
        const note = el('div', {
            id: 'lc-native-note',
            style: 'font-size:smaller;opacity:.75;line-height:1.35;margin-top:.25em'
        }, "Frozen list mode: searches this folder's cached listing only; sub-folders are not included. Comment searches use HFS's native search.")
        box.addEventListener('change', () => {
            note.textContent = box.checked
                ? 'Native deep search: scans this folder and every sub-folder; it reads the disk instead of the frozen cache.'
                : "Frozen list mode: searches this folder's cached listing only; sub-folders are not included. Comment searches use HFS's native search."
        })
        field.append(label, note)
        const submit = form.querySelector('.submit')
        if (submit)
            form.insertBefore(field, submit)
        else
            form.append(field)
    }

    document.addEventListener('submit', ev => {
        const form = ev.target
        if (!(form instanceof HTMLFormElement) || !form.closest('#search-dialog'))
            return
        const box = form.querySelector('#lc-native-deep')
        pendingNativeDeep = Boolean(box && box.checked)
    }, true)

    // the mutation observer normally catches the dialog; this also covers portals that
    // are inserted without a body mutation
    document.addEventListener('click', ev => {
        const target = ev.target
        if (target && target.closest && target.closest('#search-button'))
            setTimeout(enhanceSearchDialog, 120)
    }, true)

    // pressing Search while its results are shown first releases those results and
    // re-opens the dialog on the frozen listing, so the frozen note and the deep-search
    // option are there again
    document.addEventListener('click', ev => {
        if (!state.remoteSearch || !nativeSuspend || state.uri !== suspendedUri)
            return
        const target = ev.target
        const btn = target && target.closest && target.closest('#search-button')
        if (!btn)
            return
        ev.preventDefault()
        ev.stopPropagation()
        reopenSearchFresh()
    }, true)

    function reopenSearchFresh() {
        const my = ++reopenSearchToken
        try { state.stopSearch?.() }
        catch (e) { /* ignore */ }
        try { state.remoteSearch = undefined }
        catch (e) { /* ignore */ }
        const started = Date.now()
        const tick = () => {
            if (my !== reopenSearchToken)
                return
            const btn = document.getElementById('search-button')
            if (btn && document.body.classList.contains('lc-frozen') && !state.loading) {
                btn.click()
                return
            }
            if (Date.now() - started > 8000) {
                const fallback = document.getElementById('search-button')
                if (fallback)
                    fallback.click()
                return
            }
            setTimeout(tick, 120)
        }
        setTimeout(tick, 80)
    }

    // ---- immediate comment refresh ---------------------------------------------------------
    // HFS saves a file/folder comment through POST /~/api/comment. The frozen row keeps
    // the old object, so after a successful save ask the backend for the current comment
    // (read from descript.ion) and force React to redraw that row.

    function safeDecode(value) {
        try { return decodeURIComponent(value) }
        catch (e) { return value }
    }

    async function refreshAfterComment(uri, atUri) {
        if (!info || currentUri !== atUri)
            return
        let res = null
        try { res = await HFS.customRestCall('lc_comment', { uri }) }
        catch (e) { /* comments may be stored in attributes instead */ }
        if (!info || currentUri !== atUri)
            return
        const want = safeDecode(uri)
        let found = null
        for (const entry of currentList()) {
            if (!entry || !entry.uri || safeDecode(entry.uri) !== want)
                continue
            found = entry
            if (res && !res.unavailable) {
                if (res.comment)
                    entry.comment = res.comment
                else
                    delete entry.comment
            }
            break
        }
        if (found) {
            prefetched.clear() // neighboring pages may hold the old comment
            if (info.localSort) {
                const target = (localEntries || []).find(e => e && found && e.uri === found.uri)
                if (target) {
                    if (found.comment)
                        target.comment = found.comment
                    else
                        delete target.comment
                }
                updateCachedComment(atUri, uri, found.comment || '')
                // Keep the current row order and the cached Fixed order. The tag order
                // is applied on the next real page load, not while the player is using
                // this snapshot. Paging through this document keeps the old order.
                setLocalList([...currentList()])
                markFrozenDirty(atUri, false)
            }
            else if (filtering)
                state.list = [...currentList()]
            else
                resortPageContaining(found)
        }
    }

    // ---- "operation needs a rebuild" notice ------------------------------------------------
    // HFS performs file operations on disk normally, but this page keeps showing the frozen
    // snapshot. Remember that the snapshot is stale, show a toast, and let the sticker say a
    // rebuild is needed. A newer meta.updatedAt means the snapshot was rebuilt, so the mark
    // clears itself the next time the folder is opened.

    function frozenDirtyKey(uri) {
        return 'lc-dirty:' + uri
    }

    function readFrozenDirty(uri, updatedAt) {
        try {
            const at = Number(localStorage.getItem(frozenDirtyKey(uri)))
            if (!at)
                return false
            const built = Date.parse(updatedAt || '')
            if (Number.isFinite(built) && built >= at) {
                localStorage.removeItem(frozenDirtyKey(uri))
                return false
            }
            return true
        }
        catch (e) { return false }
    }

    function markFrozenDirty(uri, notify) {
        const target = uri || currentUri
        if (!target)
            return
        try { localStorage.setItem(frozenDirtyKey(target), String(Date.now())) }
        catch (e) { /* storage can be disabled */ }
        try {
            if (typeof HFS !== 'undefined' && typeof HFS.customRestCall === 'function')
                HFS.customRestCall('lc_dirty', { uri: target }).catch(() => {})
        }
        catch (e) { /* keep the local warning if the marker cannot be written */ }
        if (info && currentUri === target) {
            info.dirty = true
            ensureSticker()
        }
        if (!notify)
            return
        clearTimeout(dirtyToastTimer)
        dirtyToastTimer = setTimeout(() => {
            try {
                if (typeof HFS.toast === 'function')
                    HFS.toast('Change detected. Use Folder menu > Rebuild Frolist or double click to rebuild the listing.', 'success')
            }
            catch (e) { /* never break the page */ }
        }, 350)
    }

    // delete / rename / create folder / move_files (cut & paste) go through HFS's API.
    // None of them rebuild the frozen listing automatically; they only flag the
    // header so the user can double-click it when convenient.
    const MUTATION_PATH = /\/~\/api\/(?:delete|rename|create_folder|move_files|copy_files|upload)(?:$|[?#])/i

    function targetPath(value) {
        try {
            const u = new URL(value, location.origin)
            return decodedPath(u.pathname)
        }
        catch (e) { return decodedPath(String(value || '')) }
    }

    function pathIsTarget(full, targets) {
        const value = decodedPath(full)
        return targets.some(target => {
            if (!target)
                return false
            if (value === target)
                return true
            return value.startsWith(target.endsWith('/') ? target : target + '/')
        })
    }

    function recalcCachedAll(cached) {
        if (!cached || !Array.isArray(cached.entries))
            return
        cached.count = cached.entries.length
        const size = Number(cached.pageSize) || pageSize()
        cached.pages = Math.max(1, Math.ceil(cached.entries.length / size))
    }

    // Session-only simulation: update the page/player snapshot without touching the
    // frozen backend. The header stays dirty and a manual double-click rebuild makes
    // the change permanent.
    function removeSessionTargets(rawTargets) {
        if (!info)
            return false
        const base = sessionBase()
        const targets = (rawTargets || []).map(targetPath).filter(Boolean)
        if (!targets.length)
            return false
        let changed = false
        const cached = lcAllCache.get(base)
        if (cached && Array.isArray(cached.entries)) {
            const before = cached.entries.length
            cached.entries = cached.entries.filter(entry => {
                const name = String(entry && entry.n || '')
                const full = base + encodeURIComponent(name.replace(/\/$/, '')) + (name.endsWith('/') ? '/' : '')
                return !pathIsTarget(full, targets)
            })
            if (cached.entries.length !== before) {
                recalcCachedAll(cached)
                changed = true
            }
        }
        if (localEntries) {
            const fullUri = entry => entry.uri || (base + encodeURIComponent(String(entry.n || '').replace(/\/$/, '')) + (String(entry.n || '').endsWith('/') ? '/' : ''))
            const before = localEntries.length
            localEntries = localEntries.filter(entry => !(entry && pathIsTarget(fullUri(entry), targets)))
            if (localEntries.length !== before) {
                changed = true
                clearLocalOrders()
                info.count = localEntries.length
                ensureSticker()
                if (!localFileShowOpen)
                    restoreLocalFull()
            }
        }
        return changed
    }

    function addSessionEntry(name, isFolder) {
        if (!info || !localEntries)
            return false
        const clean = String(name || '').replace(/^\/+|\/+$/g, '')
        if (!clean || clean.includes('/'))
            return false
        const n = clean + (isFolder ? '/' : '')
        if (localEntries.some(e => e && e.n === n))
            return false
        const now = new Date().toISOString()
        const raw = { n, s: 0, m: now, c: now }
        try { localEntries.push(new HFS.DirEntry(n, raw)) }
        catch (e) { return false }
        const cached = lcAllCache.get(sessionBase())
        if (cached && Array.isArray(cached.entries)) {
            cached.entries.push(raw)
            recalcCachedAll(cached)
        }
        clearLocalOrders()
        info.count = localEntries.length
        ensureSticker()
        if (!localFileShowOpen)
            restoreLocalFull()
        return true
    }

    function isInFrozenFolder(url, uri) {
        const base = uri || currentUri
        if (!base)
            return false
        try {
            const u = new URL(url, location.origin)
            return u.origin === location.origin && u.pathname.startsWith(base)
        }
        catch (e) { return String(url).startsWith(base) }
    }

    if (typeof window.fetch === 'function') {
        const nativeFetch = window.fetch
        window.fetch = function (...args) {
            const promise = nativeFetch.apply(this, args)
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url
                const init = args[1] || {}
                const method = String(init.method || (args[0] && args[0].method) || 'GET').toUpperCase()
                const atUri = currentUri
                const wasFrozen = !!info
                if (url && /\/~\/api\/comment(?:$|[?#])/.test(url)) {
                    let uri = ''
                    if (typeof init.body === 'string') {
                        try { uri = JSON.parse(init.body).uri || '' }
                        catch (e) { /* not our call */ }
                    }
                    if (uri) {
                        promise.then(res => {
                            if (res && res.ok)
                                setTimeout(() => refreshAfterComment(uri, atUri), 250)
                        }).catch(() => {})
                    }
                }
                if (url && MUTATION_PATH.test(url)) {
                    promise.then(res => {
                        if (!res || !res.ok || !wasFrozen || atUri !== currentUri)
                            return
                        let body = null
                        if (typeof init.body === 'string') {
                            try { body = JSON.parse(init.body) }
                            catch (e) { /* not JSON */ }
                        }
                        if (/\/create_folder(?:$|[?#])/.test(url) && body && body.name)
                            addSessionEntry(body.name, true)
                        else if (/\/delete(?:$|[?#])/.test(url) && body) {
                            const targets = []
                            if (body.uri) targets.push(body.uri)
                            if (Array.isArray(body.uris)) targets.push(...body.uris)
                            if (targets.length)
                                removeSessionTargets(targets)
                        }
                        markFrozenDirty(atUri, true)
                    }).catch(() => {})
                }
                // HFS deletes a single entry with DELETE (or POST) to the entry URI itself.
                if (url && (method === 'DELETE' || method === 'POST') && wasFrozen
                    && !/\/~\/api\//.test(url) && isInFrozenFolder(url, atUri)) {
                    promise.then(res => {
                        if (res && res.ok && atUri === currentUri) {
                            removeSessionTargets([targetPath(url)])
                            markFrozenDirty(atUri, true)
                        }
                    }).catch(() => {})
                }
                if (method === 'PUT' && url && wasFrozen && isInFrozenFolder(url, atUri)) {
                    promise.then(res => {
                        if (!res || !res.ok || atUri !== currentUri)
                            return
                        const target = targetPath(url)
                        const base = decodedPath(sessionBase())
                        const name = target.slice(base.length)
                        if (name && !name.includes('/'))
                            addSessionEntry(name, false)
                        markFrozenDirty(atUri, true)
                    }).catch(() => {})
                }
            }
            catch (e) { /* never break a fetch */ }
            return promise
        }
    }

    // uploads use XMLHttpRequest PUT directly to the target path (not an api/ endpoint)
    if (typeof XMLHttpRequest === 'function') {
        const nativeOpen = XMLHttpRequest.prototype.open
        const nativeSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__lcMethod = String(method || '').toUpperCase()
            this.__lcUrl = String(url || '')
            return nativeOpen.apply(this, arguments)
        }
        XMLHttpRequest.prototype.send = function () {
            try {
                const atUri = currentUri
                const wasFrozen = !!info
                this.addEventListener('load', function () {
                    if (!wasFrozen || this.status < 200 || this.status >= 300 || atUri !== currentUri)
                        return
                    if (this.__lcMethod === 'PUT' && isInFrozenFolder(this.__lcUrl, atUri)) {
                        const target = targetPath(this.__lcUrl)
                        const base = decodedPath(sessionBase())
                        const name = target.slice(base.length)
                        if (name && !name.includes('/'))
                            addSessionEntry(name, false)
                        markFrozenDirty(atUri, true)
                    }
                })
            }
            catch (e) { /* never break a request */ }
            return nativeSend.apply(this, arguments)
        }
    }

    // Pin lc_all for the lifetime of this document. Musicplayer+ and the local list
    // therefore keep one stable snapshot while a background rebuild is running.
    if (typeof HFS !== 'undefined' && typeof HFS.customRestCall === 'function' && !HFS.__lcSessionAll) {
        const nativeCustomRest = HFS.customRestCall.bind(HFS)
        HFS.customRestCall = function (name, params, ...rest) {
            if (name === 'lc_meta' && params && typeof params.uri === 'string') {
                const key = sessionKey(params.uri)
                if (lcMetaCache.has(key))
                    return Promise.resolve(lcMetaCache.get(key))
                return nativeCustomRest(name, params, ...rest).then(res => {
                    if (res && !res.error)
                        lcMetaCache.set(key, res)
                    return res
                })
            }
            if (name === 'lc_all' && params && typeof params.uri === 'string') {
                const key = sessionKey(params.uri)
                if (lcAllCache.has(key))
                    return Promise.resolve(lcAllCache.get(key))
                return nativeCustomRest(name, params, ...rest).then(res => {
                    if (res && !res.error && Array.isArray(res.entries))
                        lcAllCache.set(key, res)
                    return res
                })
            }
            return nativeCustomRest(name, params, ...rest)
        }
        HFS.__lcSessionAll = true
    }

    // keep the sticker and page bar in place across HFS re-renders
    function scheduleRefresh() {
        if (refreshScheduled || !info)
            return
        refreshScheduled = true
        setTimeout(() => {
            refreshScheduled = false
            if (!info)
                return
            ensureSticker()
            enhanceSearchDialog()
            syncHeaderHeight()
            syncHeaderShare()
            if (!filtering && !(info && info.localSort))
                mountPager()
        }, 80)
    }
    new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true })

    // HFS file-show reads HFS.state.list when it opens, and its Delete action
    // chooses the next entry from that same list. Put the complete ordered list
    // in place before HFS opens the dialog, otherwise HFS picks its next entry
    // from the page-sized slice and the player jumps to the wrong video.
    if (typeof HFS !== 'undefined' && typeof HFS.fileShow === 'function' && !HFS.__lcFileShowWrapped) {
        const nativeFileShow = HFS.fileShow.bind(HFS)
        HFS.fileShow = function (entry, ...rest) {
            if (info && info.localSort && localEntries && !localFileShowOpen) {
                localListWrite = true
                localListArray = localOrderForCurrentSort().slice()
                try { state.page_size = Number(info.pageSize) || pageSize() }
                catch (e) { /* ignore */ }
                state.list = localListArray
                setTimeout(() => { localListWrite = false }, 0)
            }
            return nativeFileShow(entry, ...rest)
        }
        HFS.__lcFileShowWrapped = true
    }

    function fileShowIsVisible() {
        for (const el of document.querySelectorAll('.file-show')) {
            if (!el.isConnected)
                continue
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden')
                continue
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0)
                return true
        }
        return false
    }

    function syncLocalFileShow() {
        if (!info || !info.localSort || !localEntries) {
            localFileShowOpen = false
            return
        }
        const open = fileShowIsVisible()
        if (open === localFileShowOpen)
            return
        localFileShowOpen = open
        if (open) {
            // FileShow navigates HFS.state.list; hand it the complete local list temporarily
            try { state.page_size = Number(info.pageSize) || pageSize() }
            catch (e) { /* ignore */ }
            setLocalList([...localOrderForCurrentSort()])
        }
        else {
            renderLocalPage(activePage)
        }
    }
    let fileShowSyncTimer = 0
    const scheduleFileShowSync = () => {
        clearTimeout(fileShowSyncTimer)
        fileShowSyncTimer = setTimeout(syncLocalFileShow, 180)
    }
    new MutationObserver(scheduleFileShowSync).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
    })
})()
