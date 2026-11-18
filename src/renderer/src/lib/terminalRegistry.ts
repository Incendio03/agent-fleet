import type { Terminal } from '@xterm/xterm'

/**
 * Routes live PTY output to the right xterm instance.
 *
 * The backend streams output for every tab over a single channel. A terminal's
 * xterm instance only exists while its component is mounted, and output can
 * arrive *before* that happens (claude starts printing the moment it spawns).
 * So we buffer any output for a not-yet-registered tab and flush it the instant
 * the terminal registers. Nothing is lost.
 */
const terminals = new Map<string, Terminal>()
const pending = new Map<string, string[]>()
let started = false

/** Subscribe once to the backend's data stream. Call from app init. */
export function startTerminalRouting(): void {
  if (started) return
  started = true
  window.fleet.onTabData((tabId, chunk) => {
    const term = terminals.get(tabId)
    if (term) {
      term.write(chunk)
    } else {
      const buf = pending.get(tabId) ?? []
      buf.push(chunk)
      // Cap the pre-mount buffer so a chatty agent can't grow it unbounded.
      if (buf.length > 2000) buf.shift()
      pending.set(tabId, buf)
    }
  })
}

export function registerTerminal(tabId: string, term: Terminal): void {
  terminals.set(tabId, term)
  const buffered = pending.get(tabId)
  if (buffered) {
    for (const chunk of buffered) term.write(chunk)
    pending.delete(tabId)
  }
}

export function unregisterTerminal(tabId: string): void {
  terminals.delete(tabId)
  pending.delete(tabId)
}
