import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry'
import { registerImageLinks } from '../lib/imageLinks'

/**
 * One live terminal for one tab.
 *
 * We keep a terminal mounted for the whole life of its tab (even when another
 * tab is active — it's just hidden) so scrollback and the running agent are
 * never lost when switching tabs. `active` controls visibility and triggers a
 * refit when this tab comes to the foreground.
 */
export function TerminalView({
  tabId,
  active,
  focusOnActive = true
}: {
  tabId: string
  active: boolean
  /** Focus the terminal when shown (agent tabs focus the message box instead). */
  focusOnActive?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Whether this tab's agent process is alive. When it (re)starts, the PTY is
  // spawned at a default 80x24, so we must send our real size again.
  const isLive = useStore((s) => s.liveTabIds.has(tabId))

  // Create the xterm instance once, on mount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      theme: {
        background: '#0d0d10',
        foreground: '#e6e6e6',
        cursor: '#7aa2f7',
        selectionBackground: '#33467c'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const imageLinks = registerImageLinks(term, tabId)
    term.open(host)

    termRef.current = term
    fitRef.current = fit
    registerTerminal(tabId, term)

    // Ctrl+C (or Ctrl+Shift+C) with text selected copies it instead of
    // interrupting the agent; without a selection it goes through as usual.
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+V with an image on the clipboard: save it and type its path.
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v' && window.fleet.clipboardHasImage()) {
        e.preventDefault()
        void pasteImageToAgent()
        return false
      }
      if (e.type === 'keydown' && e.ctrlKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        e.preventDefault()
        return false
      }
      return true
    })

    // Pasting an image into the terminal: save it to the project and type its
    // path (terminals can only paste text). Text pastes are left to xterm.
    const pasteImageToAgent = async (): Promise<void> => {
      const { tabs, setError } = useStore.getState()
      const projectId = tabs.find((t) => t.id === tabId)?.projectId
      const dataUrl = await window.fleet.readClipboardImage()
      if (!dataUrl) return
      if (!projectId) return setError('This terminal has no project to save the image into.')
      try {
        const path = await window.fleet.saveShot(projectId, dataUrl)
        window.fleet.sendInput(tabId, `"${path}" `)
      } catch (err) {
        setError(`Could not paste image: ${(err as Error).message}`)
      }
    }
    const onPaste = (e: ClipboardEvent): void => {
      const data = e.clipboardData
      if (!data || data.getData('text/plain')) return
      e.preventDefault()
      e.stopPropagation()
      void pasteImageToAgent()
    }
    host.addEventListener('paste', onPaste, true)

    // Keystrokes -> backend -> agent's stdin.
    const inputDisposable = term.onData((data) => window.fleet.sendInput(tabId, data))

    // Fit to the container, then tell the PTY our real size. Skipped while
    // hidden (display:none measures as 0 and would send a bogus size).
    const doFit = (): void => {
      if (!host.offsetWidth || !host.offsetHeight) return
      try {
        fit.fit()
        window.fleet.resize(tabId, term.cols, term.rows)
      } catch {
        /* host not measurable yet */
      }
    }
    const raf = requestAnimationFrame(doFit)

    // Refit when the container resizes — debounced, so a drag (e.g. the
    // browser splitter) sends ONE final size. Every resize makes Claude Code
    // redraw its whole screen; a burst of them leaves half-drawn frames.
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(doFit, 150)
    })
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      ro.disconnect()
      inputDisposable.dispose()
      imageLinks.dispose()
      host.removeEventListener('paste', onPaste, true)
      unregisterTerminal(tabId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // tabId is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // When this tab becomes active (just became visible) or its agent (re)starts
  // (PTY spawned at 80x24), refit and send the real size + focus.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) {
          window.fleet.resize(tabId, term.cols, term.rows)
          if (focusOnActive) term.focus()
        }
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, tabId, isLive, focusOnActive])

  return <div ref={hostRef} className="terminal-host" style={{ display: active ? 'block' : 'none' }} />
}
