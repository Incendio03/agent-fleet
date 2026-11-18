import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

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

/**
 * Side browser (one per window). Browse any page; "Annotate" lets you box an
 * area directly on the page and send the full screenshot (with the box and an
 * optional note drawn on it) to the active agent.
 */
export function BrowserPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const wvRef = useRef<WebviewEl | null>(null)
  const [initialSrc] = useState(() => {
    try { return localStorage.getItem('fleet.browser.url') || HOME } catch { return HOME }
  })
  const [address, setAddress] = useState(initialSrc)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, fwd: false })
  const [snipping, setSnipping] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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
    const wv = wvRef.current
    if (!wv || typeof wv.getZoomLevel !== 'function') return
    const level = delta === null ? 0 : Math.min(Math.max(wv.getZoomLevel() + delta, -5), 5)
    wv.setZoomLevel(level)
    setZoom(Math.round(Math.pow(1.2, level) * 100))
  }

  useEffect(() => window.fleet.onBrowserZoom(setZoom), [])
  const setError = useStore((s) => s.setError)

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return
    const sync = (): void => {
      const url = wv.getURL()
      setAddress(url)
      setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
      try { localStorage.setItem('fleet.browser.url', url) } catch { /* ignore */ }
    }
    const start = (): void => setLoading(true)
    const stop = (): void => { setLoading(false); sync() }
    // Chromium remembers zoom per site; reflect it after each navigation.
    const syncZoom = (): void => {
      const z = (wv as unknown as { getZoomFactor?: () => number }).getZoomFactor?.()
      if (z) setZoom(Math.round(z * 100))
    }
    wv.addEventListener('did-finish-load', syncZoom)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-start-loading', start)
    wv.addEventListener('did-stop-loading', stop)
    return () => {
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-start-loading', start)
      wv.removeEventListener('did-stop-loading', stop)
      wv.removeEventListener('did-finish-load', syncZoom)
    }
  }, [])

  const go = (): void => {
    const url = normalizeUrl(address)
    setAddress(url)
    void wvRef.current?.loadURL(url).catch(() => { /* navigation errors show in-page */ })
  }

  const toggleSnip = (): void => {
    if (typeof wvRef.current?.getWebContentsId !== 'function') {
      setError('Browser not initialised — fully restart the app (stop and re-run npm run dev).')
      return
    }
    setSnipping((v) => !v)
  }

  return (
    <div className="browser-panel">
      <div className="browser-bar">
        <button className="icon-btn" disabled={!nav.back} onClick={() => wvRef.current?.goBack()} title="Back">‹</button>
        <button className="icon-btn" disabled={!nav.fwd} onClick={() => wvRef.current?.goForward()} title="Forward">›</button>
        <button
          className="icon-btn"
          onClick={() => (loading ? wvRef.current?.stop() : wvRef.current?.reload())}
          title={loading ? 'Stop' : 'Reload'}
        >
          {loading ? '×' : '↻'}
        </button>
        <input
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
          title="Drag a box on the page, add an optional note, send to the agent"
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
                  <button className="zoom-value" onClick={() => zoomBy(null)} title="Reset (Ctrl 0)">{zoom}%</button>
                  <button className="icon-btn" onClick={() => zoomBy(0.5)} title="Zoom in (Ctrl +)">+</button>
                </span>
              </div>
              <button className="kebab-item" onClick={() => { setMenuOpen(false); onClose() }}>Close browser</button>
            </div>
          )}
        </div>
      </div>
      <div className="browser-stage">
        <webview
          ref={(el) => { wvRef.current = el as WebviewEl | null }}
          className="browser-view"
          src={initialSrc}
          partition="persist:fleet-browser"
        />
        {snipping && wvRef.current && (
          <SnipOverlay webviewId={wvRef.current.getWebContentsId()} onDone={() => setSnipping(false)} />
        )}
      </div>
    </div>
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
  const liveTabIds = useStore((s) => s.liveTabIds)
  const tabTitle = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.title)
  const setError = useStore((s) => s.setError)
  const canSend = activeProjectId != null && activeTabId != null && liveTabIds.has(activeTabId)

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
      const path = await window.fleet.saveShot(activeProjectId!, c.toDataURL('image/png'))
      // Typed into the prompt without Enter, so you can keep writing.
      const text = note.trim()
      window.fleet.sendInput(activeTabId!, text ? `${text} (see red box in "${path}") ` : `"${path}" `)
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
            placeholder="Add a note (optional), Enter to send"
          />
          <div className="snip-actions">
            <button className="btn sm ghost" onClick={onDone}>Cancel</button>
            <button
              className="btn sm outline"
              disabled={!canSend || sending}
              onClick={() => void send()}
              title={canSend ? '' : 'Select a running agent tab first'}
            >
              {sending ? 'Sending…' : canSend ? `Send to ${tabTitle}` : 'No running agent'}
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
