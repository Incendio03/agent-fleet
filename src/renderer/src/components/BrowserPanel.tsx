import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { attachToComposer } from './Composer'

/** The subset of Electron's WebviewTag API we use (the renderer has no electron types). */
interface WebviewEl extends HTMLElement {
  getURL(): string
  getWebContentsId(): number
  setZoomLevel(level: number): void
  getZoomLevel(): number
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

const HOME = 'https://www.google.com'

/** Turn whatever the user typed into a loadable URL (or a search). */
function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return HOME
  if (/^(https?:\/\/|about:)/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** One browser tab. `src` is what its webview was created with (never changes). */
interface BTab {
  id: string
  src: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  back: boolean
  fwd: boolean
  zoom: number
}

const TABS_KEY = 'fleet.browser.tabs'
const newId = (): string => Math.random().toString(36).slice(2, 10)
const makeTab = (url: string): BTab => ({
  id: newId(),
  src: url,
  url,
  title: 'New tab',
  loading: false,
  back: false,
  fwd: false,
  zoom: 100
})

/** Restore saved tabs (falls back to the single URL older versions saved). */
function loadSession(): { tabs: BTab[]; active: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null') as { urls: string[]; active: number } | null
    if (saved?.urls?.length) {
      const tabs = saved.urls.map(makeTab)
      return { tabs, active: tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)].id }
    }
  } catch { /* ignore */ }
  let url = HOME
  try { url = localStorage.getItem('fleet.browser.url') || HOME } catch { /* ignore */ }
  const t = makeTab(url)
  return { tabs: [t], active: t.id }
}

/**
 * Side browser (one per window) with tabs. Browse any page; "Annotate" boxes
 * an area on the current tab and attaches the screenshot to the active agent.
 * Ctrl+T / Ctrl+W open/close tabs; links that open a new window open a tab.
 */
export function BrowserPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [session] = useState(loadSession)
  const [tabs, setTabs] = useState<BTab[]>(session.tabs)
  const [activeId, setActiveId] = useState(session.active)
  const views = useRef(new Map<string, WebviewEl>())
  const [address, setAddress] = useState('')
  const [snipping, setSnipping] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const setError = useStore((s) => s.setError)

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const wv = (): WebviewEl | undefined => views.current.get(active?.id)

  // Latest values for IPC callbacks registered once.
  const latest = useRef({ tabs, activeId })
  latest.current = { tabs, activeId }

  const patch = useCallback((id: string, p: Partial<BTab>): void => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)))
  }, [])

  /**
   * Open a tab. Like Chrome: new tabs (+, Ctrl+T) go at the far right; links
   * that open a new window go just right of the current tab.
   */
  const openTab = useCallback((url: string, focusAddress = false, nextToCurrent = false): void => {
    const t = makeTab(url)
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.id === latest.current.activeId)
      if (!nextToCurrent || i < 0) return [...ts, t]
      const next = [...ts]
      next.splice(i + 1, 0, t)
      return next
    })
    setActiveId(t.id)
    if (focusAddress) requestAnimationFrame(() => urlRef.current?.focus())
  }, [])

  const closeTab = useCallback((id: string): void => {
    const { tabs: ts, activeId: cur } = latest.current
    const i = ts.findIndex((t) => t.id === id)
    if (i < 0) return
    views.current.delete(id)
    if (ts.length === 1) {
      // Always keep one tab: closing the last one starts a fresh page.
      const t = makeTab(HOME)
      setTabs([t])
      setActiveId(t.id)
      return
    }
    const rest = ts.filter((t) => t.id !== id)
    setTabs(rest)
    if (cur === id) setActiveId(rest[Math.min(i, rest.length - 1)].id)
  }, [])

  // Remember tabs across restarts.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({
        urls: tabs.map((t) => t.url),
        active: Math.max(0, tabs.findIndex((t) => t.id === activeId))
      }))
    } catch { /* ignore */ }
  }, [tabs, activeId])

  // Address bar follows the current tab.
  useEffect(() => { if (active) setAddress(active.url) }, [active?.id, active?.url])

  // Leaving a tab ends any annotation in progress.
  useEffect(() => { setSnipping(false) }, [activeId])

  // From main: links that want a new window, and Ctrl+T / Ctrl+W pressed inside a page.
  useEffect(() => {
    // Optional calls: after a hot reload the preload may predate these (until a
    // full restart) — degrade instead of crashing the whole UI.
    const off1 = window.fleet.onBrowserOpenTab?.((url) => openTab(url, false, true))
    const off2 = window.fleet.onBrowserShortcut?.((action) => {
      if (action === 'newTab') openTab(HOME, true)
      else if (action === 'closeTab') closeTab(latest.current.activeId)
    })
    return () => { off1?.(); off2?.() }
  }, [openTab, closeTab])

  // Zoom changes from Ctrl+/-/wheel inside the (focused = current) page.
  useEffect(() => window.fleet.onBrowserZoom((z) => patch(latest.current.activeId, { zoom: z })), [patch])

  // Close the kebab menu on any click outside it.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  /** Step zoom like Chrome (~10% per step); null resets to 100%. */
  const zoomBy = (delta: number | null): void => {
    const v = wv()
    if (!v || typeof v.getZoomLevel !== 'function') return
    const level = delta === null ? 0 : Math.min(Math.max(v.getZoomLevel() + delta, -5), 5)
    v.setZoomLevel(level)
    patch(active.id, { zoom: Math.round(Math.pow(1.2, level) * 100) })
  }

  const go = (): void => {
    const url = normalizeUrl(address)
    setAddress(url)
    void wv()?.loadURL(url).catch(() => { /* navigation errors show in-page */ })
  }

  const toggleSnip = (): void => {
    if (typeof wv()?.getWebContentsId !== 'function') {
      setError('Browser not initialised — fully restart the app (stop and re-run npm run dev).')
      return
    }
    setSnipping((v) => !v)
  }

  // Ctrl+T / Ctrl+W while focus is in the panel itself (e.g. the address bar).
  const onPanelKey = (e: React.KeyboardEvent): void => {
    if (!e.ctrlKey || e.altKey || e.shiftKey) return
    const k = e.key.toLowerCase()
    if (k === 't') { e.preventDefault(); openTab(HOME, true) }
    else if (k === 'w') { e.preventDefault(); closeTab(activeId) }
  }

  return (
    <div className="browser-panel" onKeyDown={onPanelKey}>
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser-tab ${t.id === active?.id ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(t.id) }}
            title={`${t.title}\n${t.url}`}
          >
            {t.loading ? (
              <span className="spinner sm browser-tab-icon" />
            ) : t.favicon ? (
              <img className="browser-tab-icon" src={t.favicon} alt="" />
            ) : (
              <span className="browser-tab-icon dot" />
            )}
            <span className="browser-tab-title">{t.title || t.url}</span>
            <button
              className="browser-tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}
              title="Close tab (Ctrl+W)"
            >
              ×
            </button>
          </div>
        ))}
        <button className="browser-tab-new" onClick={() => openTab(HOME, true)} title="New tab (Ctrl+T)">+</button>
      </div>
      <div className="browser-bar">
        <button className="icon-btn" disabled={!active?.back} onClick={() => wv()?.goBack()} title="Back">‹</button>
        <button className="icon-btn" disabled={!active?.fwd} onClick={() => wv()?.goForward()} title="Forward">›</button>
        <button
          className="icon-btn"
          onClick={() => (active?.loading ? wv()?.stop() : wv()?.reload())}
          title={active?.loading ? 'Stop' : 'Reload'}
        >
          {active?.loading ? '×' : '↻'}
        </button>
        <input
          ref={urlRef}
          className="browser-url"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          placeholder="URL or search"
        />
        <button
          className={`btn sm outline ${snipping ? 'active' : ''}`}
          onClick={toggleSnip}
          title="Drag a box on the page, add an optional note, attach it to the agent"
        >
          Annotate
        </button>
        <div className="kebab" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} title="More">⋮</button>
          {menuOpen && (
            <div className="kebab-menu">
              <div className="kebab-row">
                <span>Zoom</span>
                <span className="zoom-ctrl">
                  <button className="icon-btn" onClick={() => zoomBy(-0.5)} title="Zoom out (Ctrl −)">−</button>
                  <button className="zoom-value" onClick={() => zoomBy(null)} title="Reset (Ctrl 0)">{active?.zoom ?? 100}%</button>
                  <button className="icon-btn" onClick={() => zoomBy(0.5)} title="Zoom in (Ctrl +)">+</button>
                </span>
              </div>
              <button className="kebab-item" onClick={() => { setMenuOpen(false); openTab(HOME, true) }}>New tab</button>
              <button className="kebab-item" onClick={() => { setMenuOpen(false); onClose() }}>Close browser</button>
            </div>
          )}
        </div>
      </div>
      <div className="browser-stage">
        {tabs.map((t) => (
          <BrowserTabView
            key={t.id}
            tab={t}
            visible={t.id === active?.id}
            onPatch={patch}
            register={(el) => {
              if (el) views.current.set(t.id, el)
              else views.current.delete(t.id)
            }}
          />
        ))}
        {snipping && wv() && (
          <SnipOverlay webviewId={wv()!.getWebContentsId()} onDone={() => setSnipping(false)} />
        )}
      </div>
    </div>
  )
}

/** One tab's page. Stays mounted while hidden so its page and scroll survive. */
function BrowserTabView({
  tab,
  visible,
  onPatch,
  register
}: {
  tab: BTab
  visible: boolean
  onPatch: (id: string, p: Partial<BTab>) => void
  register: (el: WebviewEl | null) => void
}): JSX.Element {
  const ref = useRef<WebviewEl | null>(null)

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const id = tab.id
    const sync = (): void => onPatch(id, { url: v.getURL(), back: v.canGoBack(), fwd: v.canGoForward() })
    const start = (): void => onPatch(id, { loading: true })
    const stop = (): void => { onPatch(id, { loading: false }); sync() }
    const title = (e: Event): void => onPatch(id, { title: (e as Event & { title: string }).title })
    const favicon = (e: Event): void => onPatch(id, { favicon: (e as Event & { favicons: string[] }).favicons?.[0] })
    // Chromium remembers zoom per site; reflect it after each load.
    const zoom = (): void => {
      const z = (v as unknown as { getZoomFactor?: () => number }).getZoomFactor?.()
      if (z) onPatch(id, { zoom: Math.round(z * 100) })
    }
    const events: [string, (e: Event) => void][] = [
      ['did-navigate', sync],
      ['did-navigate-in-page', sync],
      ['did-start-loading', start],
      ['did-stop-loading', stop],
      ['page-title-updated', title],
      ['page-favicon-updated', favicon],
      ['did-finish-load', zoom]
    ]
    for (const [n, f] of events) v.addEventListener(n, f)
    return () => { for (const [n, f] of events) v.removeEventListener(n, f) }
  }, [tab.id, onPatch])

  return (
    <webview
      ref={(el) => {
        ref.current = el as WebviewEl | null
        register(el as WebviewEl | null)
      }}
      className={`browser-view ${visible ? '' : 'hidden'}`}
      src={tab.src}
      partition="persist:fleet-browser"
      allowpopups="true"
    />
  )
}

type Rect = { x: number; y: number; w: number; h: number }
const BOX_COLOR = '#ff3b30'

/**
 * Snipping-tool style overlay on top of the live page. Drag a box, optionally
 * type a note, and send: the WHOLE page is captured with the box + note drawn
 * on it, saved into the project, and its path typed into the active agent.
 */
function SnipOverlay({ webviewId, onDone }: { webviewId: number; onDone: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Rect | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)

  const activeProjectId = useStore((s) => s.activeProjectId)
  const activeTabId = useStore((s) => s.activeTabId)
  const tabTitle = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.title)
  const setError = useStore((s) => s.setError)
  // Attaching only needs an agent tab; you review and send from its message box.
  const canSend = activeProjectId != null && activeTabId != null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = ref.current!.getBoundingClientRect()
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height)
    }
  }

  const onDown = (e: React.PointerEvent): void => {
    if (e.target !== ref.current) return // clicks inside the note popover
    ref.current!.setPointerCapture(e.pointerId)
    const p = local(e)
    setDrag(p)
    setBox({ x: p.x, y: p.y, w: 0, h: 0 })
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const p = local(e)
    setBox({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) })
  }
  const onUp = (): void => {
    setDrag(null)
    if (box && (box.w < 6 || box.h < 6)) setBox(null)
  }

  const send = async (): Promise<void> => {
    if (!box || !canSend || !ref.current) return
    setSending(true)
    try {
      const dataUrl = await window.fleet.captureBrowser(webviewId)
      const img = await loadImage(dataUrl)
      const k = img.naturalWidth / ref.current.getBoundingClientRect().width
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      drawMark(ctx, { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k }, note.trim(), k, c.height)
      const png = c.toDataURL('image/png')
      const path = await window.fleet.saveShot(activeProjectId!, png)
      // Attach to the agent's message box (not straight into the terminal) so
      // you can review, add to it, and send when ready.
      const text = note.trim()
      attachToComposer(
        activeTabId!,
        { path, name: path.split(/[\\/]/).pop() || path, preview: png },
        text ? `${text} (see the red box in the attached screenshot)` : undefined
      )
      onDone()
    } catch (e) {
      setError(`Annotate failed: ${(e as Error).message}`)
      setSending(false)
    }
  }

  // Place the note popover under the box, or above it if near the bottom.
  const size = ref.current?.getBoundingClientRect()
  const below = box && size ? box.y + box.h + 90 < size.height : true

  return (
    <div ref={ref} className="snip-overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {!box && <div className="snip-hint">Drag to box an area · Esc to cancel</div>}
      {box && <div className="snip-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      {box && !drag && (
        <div
          className="snip-note"
          style={{
            left: Math.min(box.x, Math.max(0, (size?.width ?? 0) - 300)),
            top: below ? box.y + box.h + 8 : Math.max(0, box.y - 84)
          }}
        >
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
            placeholder="Add a note (optional), Enter to attach"
          />
          <div className="snip-actions">
            <button className="btn sm ghost" onClick={onDone}>Cancel</button>
            <button
              className="btn sm outline"
              disabled={!canSend || sending}
              onClick={() => void send()}
              title={canSend ? 'Attach to the message box, then review and send' : 'Open an agent tab first'}
            >
              {sending ? 'Attaching…' : canSend ? `Attach to ${tabTitle}` : 'No agent tab'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not read screenshot'))
    img.src = src
  })
}

/** Draw the red box, plus the note as a label just below (or above) it. */
function drawMark(ctx: CanvasRenderingContext2D, r: Rect, note: string, k: number, imgH: number): void {
  ctx.strokeStyle = BOX_COLOR
  ctx.lineWidth = 3 * k
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  if (!note) return
  const size = 15 * k
  const pad = 6 * k
  ctx.font = `600 ${size}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  const w = ctx.measureText(note).width + pad * 2
  const h = size + pad * 2
  const y = r.y + r.h + 4 * k + h <= imgH ? r.y + r.h + 4 * k : Math.max(0, r.y - h - 4 * k)
  ctx.fillStyle = BOX_COLOR
  ctx.fillRect(r.x, y, w, h)
  ctx.fillStyle = '#fff'
  ctx.fillText(note, r.x + pad, y + pad)
}
