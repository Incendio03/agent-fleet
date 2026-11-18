import { useEffect, useRef } from 'react'
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
export function TerminalView({ tabId, active }: { tabId: string; active: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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

    // Keystrokes -> backend -> agent's stdin.
    const inputDisposable = term.onData((data) => window.fleet.sendInput(tabId, data))

    // Initial fit once layout settles, then tell the PTY our real size.
    const doFit = (): void => {
      try {
        fit.fit()
        window.fleet.resize(tabId, term.cols, term.rows)
      } catch {
        /* host not measurable yet */
      }
    }
    const raf = requestAnimationFrame(doFit)

    // Refit whenever the container resizes.
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputDisposable.dispose()
      imageLinks.dispose()
      unregisterTerminal(tabId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // tabId is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // When this tab becomes active, it just became visible — refit + focus.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) {
          window.fleet.resize(tabId, term.cols, term.rows)
          term.focus()
        }
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, tabId])

  return <div ref={hostRef} className="terminal-host" style={{ display: active ? 'block' : 'none' }} />
}
