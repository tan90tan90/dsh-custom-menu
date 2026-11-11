/**
 * dsh-custom-menu · 网页半边
 *
 * 一个设置页，两个标签页：
 *   ① 我的菜单   —— 自定义 URL 入口，显示在侧栏
 *   ② 侧栏调整   —— 把 DSH 自带的面板入口归类、折叠、隐藏
 *
 * 侧栏那些行是 React 管理的，所以：
 *   - 不移动节点，用 CSS `order` 排序（面板列是 flex 容器）
 *   - 隐藏用 display:none
 *   - 分组的标题行自己插入，React 碰不到；被重渲染冲掉就靠 MutationObserver 补回
 *
 * 数据全部存 localStorage（键 dsh.customMenu.state），重装插件不丢。
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-menu',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const STORE_KEY = 'dsh.customMenu.state'
    const ROOT_ID = 'dsh-custom-menu-root'
    const TITLE_PREFIX = 'dsh-group-title-'
    const ICONS = ['🔗', '🌐', '📁', '📌', '⭐', '✦', '◈', '◎', '♪', '🐟', '💠', '🧭', '📚', '🎬', '🛠', '⚙']
    const KNOWN_LABELS = ['新会话', '插件', '自动化任务', '更多', 'New session', 'Plugins', 'Automations', 'More']

    // ───────────────── 状态读写 ─────────────────
    function loadState() {
      const empty = { links: [], groups: [], hidden: [] }
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return empty
        const s = JSON.parse(raw)
        if (!s || typeof s !== 'object') return empty
        return {
          links: Array.isArray(s.links) ? s.links.filter((x) => x && typeof x.url === 'string') : [],
          groups: Array.isArray(s.groups) ? s.groups.filter((g) => g && typeof g === 'object') : [],
          hidden: Array.isArray(s.hidden) ? s.hidden.filter((x) => typeof x === 'string') : [],
        }
      } catch (e) {
        return empty
      }
    }

    function saveState(s) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch (e) {}
    }

    let state = loadState()

    // ───────────────── DOM：找侧栏里的行 ─────────────────
    function labelText(el) {
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || ''
      if (aria.trim()) return aria.trim()
      const direct = Array.from(el.childNodes || [])
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue || '')
        .join('')
        .trim()
      return direct || (el.textContent || '').trim()
    }

    function isClickable(el) {
      const t = el.tagName
      if (t === 'BUTTON' || t === 'A' || t === 'LI') return true
      const r = el.getAttribute('role')
      return r === 'button' || r === 'tab' || r === 'menuitem' || r === 'link'
    }

    function sidebarScope() {
      return document.querySelector("[data-slot='sidebar']") || document.body
    }

    /** 面板列：包含「新会话 / 插件 / 自动化任务 / 更多」这些行的父节点 */
    function findColumn() {
      const scope = sidebarScope()
      const clickables = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="tab"], li'))
      const anchors = clickables.filter((el) => KNOWN_LABELS.includes(labelText(el)) && el.parentElement)
      if (!anchors.length) return null
      const counts = new Map()
      for (const el of anchors) {
        const p = el.parentElement
        counts.set(p, (counts.get(p) || 0) + 1)
      }
      let best = null
      let bestN = 0
      for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n }
      return best || anchors[0].parentElement
    }

    /** 面板列里的「菜单行」：可点击 + 一小段文字 */
    function collectRows(column) {
      if (!column) return []
      const rows = []
      const seen = new Set()
      // 先收我们自己挂上去的自定义行（名字存在 data-cm-name 上）
      for (const el of Array.from(column.children)) {
        if (!el.hasAttribute || !el.hasAttribute('data-cm-custom')) continue
        seen.add(el)
        {
          const id = el.getAttribute('data-cm-custom')
          const link = (state.links || []).find((l) => l.id === id)
          const ic = document.createElement('span')
          ic.textContent = (link && link.icon) || '🔗'
          ic.style.cssText = 'font-size:13px;line-height:16px'
          rows.push({ el, label: el.getAttribute('data-cm-name') || '', custom: true, icon: ic })
        }
      }
      for (const el of column.querySelectorAll('button, a, li, [role="button"], [role="tab"], [role="menuitem"]')) {
        if (seen.has(el)) continue
        if (el.hasAttribute && el.hasAttribute('data-cm-custom')) continue
        const label = labelText(el)
        if (!label || label.length > 24) continue
        seen.add(el)
        rows.push({ el, label, icon: iconNodeOf(el) })
      }
      return rows
    }

    /** 克隆一行里的图标节点（优先 svg），给分组标题和浮层复用 */
    function iconNodeOf(el) {
      try {
        const svg = el.querySelector('svg')
        if (svg) return svg.cloneNode(true)
      } catch (e) {}
      return null
    }

    // ───────────────── 应用：排序 / 折叠 / 隐藏 / 标题 ─────────────────
    function applyDecorations() {
      if (typeof document === 'undefined') return
      const column = findColumn()
      if (!column) return
      const rows = collectRows(column)
      if (!rows.length) return

      const hiddenSet = new Set(state.hidden || [])
      const groupOf = new Map() // label -> {group, index}
      // 「更多」直接挪到父容器末尾（CSS order 在这个容器里不一定生效）
      const moreEntry = rows.find((r) => r.label === '更多' || r.label === 'More')
      if (moreEntry && moreEntry.el.parentElement) {
        guarded(() => {
          const p = moreEntry.el.parentElement
          if (p.lastElementChild !== moreEntry.el) p.appendChild(moreEntry.el)
        })
      }
      ;(state.groups || []).forEach((g, gi) => {
        for (const label of g.items || []) groupOf.set(label, { group: g, gi })
      })

      // 逐个行：排序 + 显示/隐藏
      let ungroupedOrder = 9000
      let customOrder = 1
      rows.forEach((row, naturalIdx) => {
        const g = groupOf.get(row.label)
        if (g) {
          const idx = (g.group.items || []).indexOf(row.label)
          row.el.style.order = String(g.gi * 100 + idx)
        } else if (row.custom) {
          row.el.style.order = String(customOrder++)
        } else if (row.label === '更多' || row.label === 'More') {
          row.el.style.order = '99999' // 「更多」固定排最后
        } else {
          row.el.style.order = String(ungroupedOrder++)
        }
        const collapsed = !!g // 归组后原行始终隐藏，只在浮层里出现
        if (hiddenSet.has(row.label) || collapsed) {
          row.el.style.setProperty('display', 'none', 'important')
          row.el.setAttribute('data-cm-hidden', '1')
        } else if (row.el.getAttribute('data-cm-hidden') === '1') {
          row.el.style.removeProperty('display')
          row.el.removeAttribute('data-cm-hidden')
        }
      })

      // 分组标题行：样式照「更多」那一行做，点一下弹出浮层
      // 找已存在的分组标题（可能挂在别的父节点，所以查全文档并顺手去重）
      const existing = new Map()
      for (const el of document.querySelectorAll('[data-cm-group]')) {
        const id = el.getAttribute('data-cm-group')
        if (!id) continue
        if (existing.has(id)) {
          if (el.parentElement) el.parentElement.removeChild(el)
        } else {
          existing.set(id, el)
        }
      }
      ;(state.groups || []).forEach((g, gi) => {
        const count = (g.items || []).length
        if (!count) return
        let titleEl = existing.get(g.id)
        if (!titleEl) {
          titleEl = document.createElement('div')
          titleEl.setAttribute('data-cm-group', g.id)
          titleEl.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:6px 10px;margin:2px 0;border-radius:8px;width:100%;box-sizing:border-box;align-self:stretch;cursor:pointer;' +
            'font-size:13px;line-height:20px;cursor:pointer;user-select:none'
          titleEl.onmouseenter = () => { titleEl.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' }
          titleEl.onmouseleave = () => { titleEl.style.background = 'transparent' }
          const parent0 = (moreEntry && moreEntry.el.parentElement) || column
          if (moreEntry && moreEntry.el.parentElement === parent0) parent0.insertBefore(titleEl, moreEntry.el)
          else parent0.appendChild(titleEl)
        }
        // 内容：图标 + 组名 + 数量 + 右箭头（跟原版菜单行同样的排布）
        const sig = JSON.stringify({ n: g.name, i: g.icon || null, c: count })
        if (titleEl.getAttribute('data-cm-sig') !== sig) {
          titleEl.setAttribute('data-cm-sig', sig)
          titleEl.innerHTML = ''
        const iconHost = document.createElement('span')
        iconHost.style.cssText = 'flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center'
        const gIcon = resolveGroupIcon(g, rows)
        if (gIcon) iconHost.appendChild(gIcon)
        const nameEl = document.createElement('span')
        nameEl.textContent = g.name || '未命名分组'
        nameEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

        const caretEl = document.createElement('span')
        caretEl.textContent = '›'
        caretEl.style.cssText = 'flex:none;opacity:.55;font-size:14px;transform:rotate(90deg)'
        titleEl.appendChild(iconHost)
        titleEl.appendChild(nameEl)
        titleEl.appendChild(caretEl)
        }
        // 按分组顺序重排：依次插到「更多」前面
        try {
          const parent = (moreEntry && moreEntry.el.parentElement) || column
          if (parent && titleEl.parentElement === parent) {
            if (moreEntry && moreEntry.el.parentElement === parent) parent.insertBefore(titleEl, moreEntry.el)
            else parent.appendChild(titleEl)
          }
        } catch (e) {}
        titleEl.onclick = (ev) => {
          ev.stopPropagation()
          openGroupPopover(g, titleEl, column)
        }
        existing.delete(g.id)
      })
      for (const stale of existing.values()) {
        if (stale.parentElement) stale.parentElement.removeChild(stale)
      }
    }

    /** 分组图标的解析：优先用分组自己选的，其次用组内第一项的图标 */
    function resolveGroupIcon(group, rows) {
      const spec = group && group.icon
      if (spec && spec.type === 'emoji' && spec.value) {
        const s = document.createElement('span')
        s.textContent = spec.value
        s.style.cssText = 'font-size:13px;line-height:16px'
        return s
      }
      if (spec && spec.type === 'row' && spec.value) {
        const hit = (rows || []).find((r) => r.label === spec.value)
        if (hit && hit.icon) return hit.icon.cloneNode(true)
      }
      const first = (group && group.items || [])
        .map((label) => (rows || []).find((r) => r.label === label))
        .find((r) => r && r.icon)
      return first ? first.icon.cloneNode(true) : null
    }
    // ───────────────── 分组浮层（照「更多」的样子）─────────────────
    let popEl = null

    function closeGroupPopover() {
      if (popEl && popEl.parentElement) popEl.parentElement.removeChild(popEl)
      popEl = null
    }

    /** 浮层里点到某一项时怎么动作：自定义项直接执行，原生项交给原来那行 */
    function activateLabel(label, column) {
      const link = (state.links || []).find((l) => (l.name || l.url) === label)
      if (link) {
        const isLocal = link.kind === 'local' || /^([A-Za-z]:[\\/]|\\\\)/.test(link.url)
        if (isLocal) openLocal(link.url)
        else window.open(link.url, '_blank', 'noopener')
        return
      }
      const target = collectRows(column).find((r) => r.label === label)
      if (target) {
        try { target.el.click() } catch (e) {}
      }
    }

    /** 这一项现在还存不存在（自定义项看 links，原生项看扫描结果） */
    function labelExists(label, column) {
      if ((state.links || []).some((l) => (l.name || l.url) === label)) return true
      return collectRows(column).some((r) => r.label === label)
    }
    function openGroupPopover(group, anchorEl, column) {
      closeGroupPopover()
      const host = document.createElement('div')
      host.setAttribute('data-cm-popover', '1')
      host.style.cssText =
        'position:fixed;z-index:9999;width:248px;max-width:280px;padding:6px;border-radius:10px;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.26);background:var(--dsw-alias-bg-layer-2,#fff);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,inherit);' +
        'font-size:13px;line-height:20px'

      const allRows = collectRows(column)
      for (const label of (group.items || []).filter((l) => labelExists(l, column))) {
        const item = document.createElement('div')
        item.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer;width:100%;box-sizing:border-box;' +
          'white-space:nowrap;height:32px;box-sizing:border-box'
        const hitRow = allRows.find((r) => r.label === label)
        const ic = document.createElement('span')
        ic.style.cssText = 'flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center'
        if (hitRow && hitRow.icon) ic.appendChild(hitRow.icon.cloneNode(true))
        const tx = document.createElement('span')
        tx.textContent = label
        tx.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis'
        item.appendChild(ic)
        item.appendChild(tx)
        item.onmouseenter = () => { item.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))' }
        item.onmouseleave = () => { item.style.background = 'transparent' }
        item.onclick = (ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          const link = (state.links || []).find((l) => (l.name || l.url) === label)
          if (link) {
            const isLocal = link.kind === 'local' || /^([A-Za-z]:[\\/]|\\\\)/.test(link.url)
            if (isLocal) openLocal(link.url)
            else window.open(link.url, '_blank', 'noopener')
          } else if (hitRow) {
            try { hitRow.el.click() } catch (e) {}
          }
        }
        // 双击/长按也兜一下，避免第一下被浮层关闭逻辑吞掉
        item.onmousedown = (ev) => ev.stopPropagation()
        host.appendChild(item)
      }

      document.body.appendChild(host)
      const r = anchorEl.getBoundingClientRect()
      const pw = host.offsetWidth
      const ph = host.offsetHeight
      let left = r.left + 10
      let top = r.bottom + 4
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8)
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4)
      host.style.left = left + 'px'
      host.style.top = top + 'px'
      popEl = host

      setTimeout(() => {
        const onDown = (ev) => {
          if (!popEl) return
          if (!popEl.contains(ev.target)) {
            closeGroupPopover()
            document.removeEventListener('mousedown', onDown, true)
          }
        }
        const onKey = (ev) => {
          if (ev.key === 'Escape') {
            closeGroupPopover()
            document.removeEventListener('keydown', onKey, true)
          }
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
      }, 0)
    }

    // ───────────────── 我的菜单（自定义链接）─────────────────
    const ROW_STYLE = {
      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', margin: '2px 0',
      borderRadius: '8px', cursor: 'pointer', fontSize: '13px', lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)', textDecoration: 'none', userSelect: 'none',
    }

    /** 请求宿主用资源管理器打开本地路径 */
    function openLocal(path) {
      fetch('/dsh-custom-menu/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
        .then((r) => r.json())
        .then((o) => {
          if (!o || o.ok !== true) {
            window.alert('打不开这个路径：' + ((o && o.error) || '未知错误'))
          }
        })
        .catch(() => {
          window.alert('打不开这个路径（宿主没有响应）')
        })
    }

    const ROW_ID_ATTR = 'data-cm-custom'

    function buildRow(item) {
      const isLocal =
        item.kind === 'local' ||
        (!/^https?:\/\//i.test(item.url) && /^([A-Za-z]:[\\/]|\\\\)/.test(item.url))
      const row = document.createElement(isLocal ? 'div' : 'a')
      row.setAttribute(ROW_ID_ATTR, item.id)
      row.setAttribute('data-cm-name', item.name || item.url)
      if (isLocal) {
        row.onclick = () => openLocal(item.url)
      } else {
        row.href = item.url
        row.target = '_blank'
        row.rel = 'noopener noreferrer'
      }
      row.title = item.url
      Object.assign(row.style, ROW_STYLE)
      row.onmouseenter = () => { row.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' }
      row.onmouseleave = () => { row.style.background = 'transparent' }
      const ic = document.createElement('span')
      ic.textContent = item.icon || '🔗'
      ic.style.cssText = 'flex:none;width:16px;text-align:center;font-size:13px;'
      const nm = document.createElement('span')
      nm.textContent = item.name || item.url
      nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      row.appendChild(ic)
      row.appendChild(nm)
      return row
    }

    // 防自触发：我们自己写 DOM 时把观察器静音，否则「重建节点 → 触发观察器 → 再重建」会闪成风车
    let domWrites = 0
    function guarded(fn) {
      domWrites++
      try {
        return fn()
      } finally {
        // 用 setTimeout 让本次变更记录先派发完，再恢复监听
        setTimeout(() => { domWrites = Math.max(0, domWrites - 1) }, 0)
      }
    }

    let lastLinksSig = ''

    /**
     * 自定义菜单行直接挂在侧栏列里（不再套一层容器），
     * 这样「侧栏调整」能一起扫描、分组、隐藏它们。
     */
    function mountCustomRows() {
      const column = findColumn()
      if (!column) return
      const links = state.links || []
      const sig = JSON.stringify(links)
      const existing = Array.from(column.children).filter((el) => el.hasAttribute && el.hasAttribute(ROW_ID_ATTR))
      const ids = new Set(existing.map((el) => el.getAttribute(ROW_ID_ATTR)))
      const same = existing.length === links.length && links.every((l) => ids.has(l.id))
      if (same && sig === lastLinksSig) {
        // 内容没变，但仍可能有旧容器残留
        const legacy = document.getElementById(ROOT_ID)
        if (legacy && legacy.parentElement) guarded(() => legacy.parentElement.removeChild(legacy))
        return
      }
      lastLinksSig = sig
      guarded(() => {
        // 清掉旧版本留下的外层容器（否则会看到两份一样的条目）
        const legacy = document.getElementById(ROOT_ID)
        if (legacy && legacy.parentElement) legacy.parentElement.removeChild(legacy)
        for (const el of existing) el.remove()
        for (const item of links) column.appendChild(buildRow(item))
      })
    }

    function refresh() {
      mountCustomRows()
      guarded(() => applyDecorations())
    }

    // ───────────────── 设置面板 ─────────────────
    const S = {
      wrap: {
        padding: '12px 14px 24px', fontSize: 13, lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))', borderRadius: 12,
      },
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))', marginBottom: 12 },
      tab: { padding: '6px 12px', cursor: 'pointer', fontSize: 13, border: 'none', background: 'transparent', color: 'inherit' },
      tabOn: { padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, border: 'none', background: 'transparent', color: 'inherit', borderBottom: '2px solid currentColor' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 8, padding: '10px 12px', marginTop: 10, background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))' },
      row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
      input: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6, padding: '4px 8px', fontSize: 12.5, background: 'transparent', color: 'inherit' },
      btn: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', background: 'transparent', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12.5, color: 'inherit' },
      item: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 4px', borderBottom: '1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.06))' },
      sel: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6, padding: '2px 6px', fontSize: 12, background: 'transparent', color: 'inherit' },
    }

    const uid = () => Math.random().toString(36).slice(2, 9)

    function Section() {
      const [tab, setTab] = React.useState('links')
      const [s, setS] = React.useState(loadState())
      const [rows, setRows] = React.useState([])
      const [msg, setMsg] = React.useState('')

      const commit = (next) => {
        setS(next)
        state = next
        saveState(next)
        refresh()
      }

      const rescan = () => {
        const col = findColumn()
        setRows(collectRows(col).map((r) => r.label))
      }

      React.useEffect(() => { rescan() }, [tab])

      // ---- 我的菜单 ----
      const [name, setName] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [icon, setIcon] = React.useState('🔗')
      const [mode, setMode] = React.useState('url')
      const [editingId, setEditingId] = React.useState('')
      const [sortMode, setSortMode] = React.useState(false)
      const [dragIdx, setDragIdx] = React.useState(-1)
      const [draft, setDraft] = React.useState({ name: '', url: '', icon: '🔗' })

      const addLink = () => {
        let u = url.trim()
        if (!u) { setMsg(mode === 'local' ? '文件夹路径不能为空' : '网址不能为空'); return }
        const looksPath = /^([A-Za-z]:[\\/]|\\\\)/.test(u)
        if (mode === 'local' && !looksPath) {
          setMsg('本地文件夹要填绝对路径，例如 D:\\大肥鱼日记')
          return
        }
        const isLocal = mode === 'local' || looksPath
        if (!isLocal && !/^https?:\/\//i.test(u)) u = 'https://' + u
        const kind = isLocal ? 'local' : 'url'
        const useIcon = isLocal && icon === '🔗' ? '📁' : icon
        commit({ ...s, links: s.links.concat([{ id: uid(), name: name.trim() || u, url: u, icon: useIcon, kind }]) })
        setName(''); setUrl('')
        setMsg(isLocal ? '已添加（本机文件夹，点一下用资源管理器打开）' : '已添加（点一下在新标签页打开）')
      }

      // ---- 侧栏调整 ----
      const addGroup = () => {
        commit({ ...s, groups: s.groups.concat([{ id: uid(), name: '新分组', collapsed: false, items: [] }]) })
      }
      const renameGroup = (id, v) => {
        commit({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name: v } : g)) })
      }
      const setGroupIcon = (id, icon) => {
        commit({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, icon } : g)) })
      }
      const delGroup = (id) => {
        commit({ ...s, groups: s.groups.filter((g) => g.id !== id) })
      }
      const toggleCollapse = (id) => {
        commit({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) })
      }
      const assign = (label, groupId) => {
        const groups = s.groups.map((g) => ({ ...g, items: (g.items || []).filter((x) => x !== label) }))
        if (groupId) {
          const g = groups.find((x) => x.id === groupId)
          if (g) g.items = g.items.concat([label])
        }
        const hidden = groupId ? s.hidden.filter((x) => x !== label) : s.hidden
        commit({ ...s, groups, hidden })
      }
      const toggleHidden = (label) => {
        const hidden = s.hidden.includes(label) ? s.hidden.filter((x) => x !== label) : s.hidden.concat([label])
        commit({ ...s, hidden })
      }
      const groupIdOf = (label) => {
        const g = s.groups.find((x) => (x.items || []).includes(label))
        return g ? g.id : ''
      }

      const tabBtn = (id, text) =>
        h('button', { type: 'button', style: tab === id ? S.tabOn : S.tab, onClick: () => setTab(id) }, text)

      const linksTab = h('div', null,
        h('div', { style: S.dim }, '侧栏「我的菜单」里显示这些入口，点一下在新标签页打开。'),
        h('div', { style: S.card },
          h('div', { style: { ...S.dim, marginBottom: 6 } }, '新增一条自定义菜单'),
            h('div', { style: S.row },
              h('button', { type: 'button', style: mode === 'url' ? S.tabOn : S.tab, onClick: () => { setMode('url'); if (icon === '📁') setIcon('🔗') } }, '新增浏览器页面'),
              h('button', { type: 'button', style: mode === 'local' ? S.tabOn : S.tab, onClick: () => { setMode('local'); if (icon === '🔗') setIcon('📁') } }, '新增本地文件夹'),
            ),
          h('div', { style: S.row },
            h('input', { style: { ...S.input, width: 130 }, placeholder: '名称（可空）', value: name, onChange: (e) => setName(e.target.value) }),
            h('input', { style: { ...S.input, flex: '1 1 220px', minWidth: 200 }, placeholder: mode === 'url' ? '网址，如 bilibili.com' : '文件夹路径，如 D:\\大肥鱼日记', value: url, onChange: (e) => setUrl(e.target.value) }),
            h('select', { style: S.input, value: icon, onChange: (e) => setIcon(e.target.value) }, ICONS.map((i) => h('option', { key: i, value: i }, i))),
            h('button', { style: S.btn, type: 'button', onClick: addLink }, mode === 'url' ? '添加页面' : '添加文件夹'),
          ),
          msg ? h('div', { style: { ...S.dim, color: '#c0392b' } }, msg) : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.row, marginBottom: 6 } },
            h('span', { style: S.dim }, '现有 ' + s.links.length + ' 条'),
            h('button', { style: sortMode ? { ...S.btn, borderColor: 'currentColor' } : S.btn, type: 'button', onClick: () => setSortMode(!sortMode) }, sortMode ? '完成排序' : '排序'),
            sortMode ? h('span', { style: { ...S.dim, fontSize: 11.5 } }, '按住 ⠿ 拖动调整顺序') : null,
          ),
          s.links.length === 0 ? h('div', { style: S.dim }, '还没有，上面加一条试试。')
            : s.links.map((it, i) => editingId === it.id
              ? h('div', { key: it.id, style: { ...S.item, background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03))' } },
                  h('input', { style: { ...S.input, width: 100 }, placeholder: '名称', value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }) }),
                  h('input', { style: { ...S.input, flex: '1 1 200px', minWidth: 180 }, placeholder: '网址或文件夹路径', value: draft.url, onChange: (e) => setDraft({ ...draft, url: e.target.value }) }),
                  h('select', { style: S.sel, value: draft.icon, onChange: (e) => setDraft({ ...draft, icon: e.target.value }) }, ICONS.map((ic) => h('option', { key: ic, value: ic }, ic))),
                  h('button', { style: S.btn, type: 'button', onClick: () => {
                    let u = draft.url.trim()
                    if (!u) { setMsg('地址不能为空'); return }
                    const isLocal = /^([A-Za-z]:[\\/]|\\\\)/.test(u)
                    if (!isLocal && !/^https?:\/\//i.test(u)) u = 'https://' + u
                    const oldName = it.name || it.url
                    const newName = draft.name.trim() || u
                    const links = s.links.map((x) => (x.id === it.id ? { ...x, name: newName, url: u, icon: draft.icon, kind: isLocal ? 'local' : 'url' } : x))
                    // 分组里还记着旧名字的话同步改名
                    const groups = s.groups.map((g) => ({ ...g, items: (g.items || []).map((l) => (l === oldName ? newName : l)) }))
                    commit({ ...s, links, groups })
                    setEditingId('')
                    setMsg('已保存修改')
                  } }, '保存'),
                  h('button', { style: S.btn, type: 'button', onClick: () => setEditingId('') }, '取消'),
                )
              : h('div', {
                  key: it.id,
                  style: { ...S.item, opacity: dragIdx === i ? 0.45 : 1 },
                  draggable: sortMode,
                  onDragStart: () => setDragIdx(i),
                  onDragOver: (e) => { if (sortMode) e.preventDefault() },
                  onDrop: () => {
                    if (!sortMode || dragIdx < 0 || dragIdx === i) { setDragIdx(-1); return }
                    const arr = s.links.slice()
                    const [x] = arr.splice(dragIdx, 1)
                    arr.splice(i, 0, x)
                    commit({ ...s, links: arr })
                    setDragIdx(-1)
                  },
                  onDragEnd: () => setDragIdx(-1),
                },
                  h('span', { style: { flex: 'none', width: 20, textAlign: 'center' } }, it.icon),
                  h('span', { style: { flex: 'none', minWidth: 100, fontWeight: 500 } }, it.name || '(未命名)'),
                  h('span', { style: { flex: '1 1 140px', minWidth: 0, maxWidth: 240, opacity: 0.6, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: it.url }, it.url),
                  sortMode ? h('span', { style: { flex: 'none', cursor: 'grab', userSelect: 'none', opacity: 0.65, padding: '0 4px' }, title: '拖这一行调整顺序' }, '⠿') : null,
                  h('button', { style: S.btn, type: 'button', onClick: () => {
                    setEditingId(it.id)
                    setDraft({ name: it.name || '', url: it.url || '', icon: it.icon || '🔗' })
                  } }, '修改'),
                  h('button', { style: S.btn, type: 'button', onClick: () => {
                    const name = it.name || it.url
                    const groups = s.groups.map((g) => ({ ...g, items: (g.items || []).filter((l) => l !== name) }))
                    commit({ ...s, links: s.links.filter((x) => x.id !== it.id), groups })
                  } }, '删除'),
                )),
        ),
      )

      const groupsTab = h('div', null,
        h('div', { style: S.dim }, '把侧栏的面板入口归类成可折叠的分组；也可以直接隐藏不想看的入口。只影响显示，不影响功能。'),
        h('div', { style: { ...S.dim, marginTop: 4 } }, '提示：装 dsh-plugins-sidebar-manager 会跟这个功能冲突，建议只用一个。'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('button', { style: S.btn, type: 'button', onClick: addGroup }, '新建分组'),
            h('button', { style: S.btn, type: 'button', onClick: rescan }, '重新扫描菜单'),
          ),
          (s.groups || []).length === 0 ? h('div', { style: S.dim }, '还没有分组。')
            : s.groups.map((g) => h('div', { key: g.id, style: S.item },
                h('input', { style: { ...S.input, width: 110 }, value: g.name, onChange: (e) => renameGroup(g.id, e.target.value) }),
                h('select', {
                  style: { ...S.sel, maxWidth: 150 },
                  value: g.icon ? g.icon.type + ':' + g.icon.value : '',
                  onChange: (e) => {
                    const v = e.target.value
                    if (!v) return setGroupIcon(g.id, null)
                    const idx = v.indexOf(':')
                    setGroupIcon(g.id, { type: v.slice(0, idx), value: v.slice(idx + 1) })
                  },
                },
                  h('option', { value: '' }, '图标：自动'),
                  h('optgroup', { label: '用现有菜单的图标' },
                    rows.map((label) => h('option', { key: 'row:' + label, value: 'row:' + label }, label)),
                  ),
                  h('optgroup', { label: '表情' },
                    ICONS.map((i) => h('option', { key: 'emoji:' + i, value: 'emoji:' + i }, i)),
                  ),
                ),
                h('span', { style: S.dim }, (g.items || []).filter((l) => (s.links || []).some((x) => (x.name || x.url) === l) || rows.includes(l)).length + ' 项'),
                h('span', { style: { ...S.dim, fontSize: 11.5 } }, '点侧栏标题弹出'),
                h('button', { style: S.btn, type: 'button', onClick: () => delGroup(g.id) }, '删除'),
              )),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.dim, marginBottom: 6 } }, '检测到的侧栏入口（' + rows.length + ' 个）'),
          rows.length === 0 ? h('div', { style: S.dim }, '没扫到，点「重新扫描菜单」。')
            : rows.map((label) => h('div', { key: label, style: S.item },
                h('span', { style: { flex: 1, minWidth: 90 } }, label),
                h('select', { style: S.sel, value: groupIdOf(label), onChange: (e) => assign(label, e.target.value) },
                  h('option', { value: '' }, '未分组'),
                  (s.groups || []).map((g) => h('option', { key: g.id, value: g.id }, g.name || '未命名')),
                ),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 } },
                  h('input', { type: 'checkbox', checked: s.hidden.includes(label), onChange: () => toggleHidden(label) }),
                  '隐藏',
                ),
              )),
        ),
      )

      return h('div', { style: S.wrap },
        h('div', { style: S.title }, '自定义菜单'),
        h('div', { style: S.tabs }, tabBtn('links', '我的菜单'), tabBtn('groups', '侧栏调整')),
        tab === 'links' ? linksTab : groupsTab,
      )
    }

    // ───────────────── 入口 ─────────────────
    function apply(ctx) {
      refresh()

      if (typeof MutationObserver !== 'undefined' && document.body) {
        let scheduled = false
        const obs = new MutationObserver((records) => {
          // 自己改的 DOM 不算（否则会自己触发自己，闪成风车）
          if (domWrites > 0) return
          const onlyOurs = records.every((r) => {
            const t = r.target
            return t && t.closest && t.closest('#' + ROOT_ID + ',[data-cm-group]')
          })
          if (onlyOurs) return
          if (scheduled) return
          scheduled = true
          setTimeout(() => {
            scheduled = false
            refresh()
          }, 200)
        })
        obs.observe(document.body, { childList: true, subtree: true })
        for (const ms of [400, 1200, 2500, 5000]) setTimeout(refresh, ms)
      }

      const slots = ctx.get && ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'custom-menu', order: 54, label: () => '自定义菜单' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
