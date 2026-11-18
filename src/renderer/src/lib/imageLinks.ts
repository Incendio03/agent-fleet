import type { IDisposable, ILink, Terminal } from '@xterm/xterm'
import { useStore } from '../store/useStore'

/**
 * Marks a hard line break inside the joined text. Claude Code wraps long lines
 * itself (real newlines + indentation, sometimes dropping the space it broke
 * on), so a path can span several terminal rows. We join nearby rows with this
 * marker and resolve it to "" or " " at click time by checking what exists.
 */
const BRK = '\u0001'
const SPAN = 3 // rows above/below to consider

const IMG_EXT = '(?:png|jpe?g|gif|webp)'
// Order matters: earlier patterns win when matches overlap.
const PATTERNS: { re: RegExp; kind: 'paste' | 'path' }[] = [
  // Claude Code's placeholder for a pasted image (shown before AND after sending).
  { re: new RegExp(`\\[Image ${BRK}?#(\\d+)\\]`, 'g'), kind: 'paste' },
  // Quoted Windows path (may contain spaces), e.g. what Annotate sends.
  { re: new RegExp(`"([A-Za-z]:[\\\\/][^"\\r\\n]+?\\.${IMG_EXT})"`, 'gi'), kind: 'path' },
  // Claude Code's "[Image: source: C:\...\50.png]" and other unquoted paths.
  { re: new RegExp(`([A-Za-z]:[\\\\/][^\\s"'<>|\\]]+?\\.${IMG_EXT})(?![\\w])`, 'gi'), kind: 'path' }
]

/** Every way of resolving the break markers ("" or " "), most likely first. */
function candidates(value: string): string[] {
  const parts = value.split(BRK)
  if (parts.length === 1) return [value]
  const n = Math.min(parts.length - 1, 4)
  const out: string[] = []
  for (let mask = 0; mask < 1 << n; mask++) {
    let s = parts[0]
    for (let i = 1; i < parts.length; i++) s += (i <= n && mask & (1 << (i - 1)) ? ' ' : '') + parts[i]
    out.push(s)
  }
  return out
}

/**
 * Makes image references in a tab's terminal clickable: "[Image #N]" pasted
 * placeholders and image file paths. Clicking opens the in-app image viewer.
 */
export function registerImageLinks(term: Terminal, tabId: string): IDisposable {
  const open = async (kind: 'paste' | 'path', value: string): Promise<void> => {
    const { openImage, setError } = useStore.getState()
    if (kind === 'paste') {
      const n = value.split(BRK).join('')
      const path = await window.fleet.resolveImage(tabId, Number(n))
      if (path) return openImage(path)
      return setError(`Image #${n} not found for this agent.`)
    }
    for (const path of candidates(value)) {
      try {
        await window.fleet.readImage(path)
        return openImage(path)
      } catch { /* try the next spelling */ }
    }
    setError(`Image not found: ${value.split(BRK).join('')}`)
  }

  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active
      // Build joined text for rows y-SPAN..y+SPAN, remembering where each
      // character came from so links can span rows.
      let text = ''
      const pos: { x: number; y: number }[] = []
      const from = Math.max(1, y - SPAN)
      const to = Math.min(buf.length, y + SPAN)
      for (let row = from; row <= to; row++) {
        const line = buf.getLine(row - 1)
        if (!line) continue
        let s = line.translateToString(true)
        let lead = 0
        if (row > from) {
          // Row break (hard or soft): whitespace on either side may or may not
          // be real, so collapse it into one marker resolved at click time.
          while (text.endsWith(' ')) { text = text.slice(0, -1); pos.pop() }
          lead = s.length - s.trimStart().length
          s = s.slice(lead)
          text += BRK
          pos.push({ x: lead + 1, y: row })
        }
        for (let i = 0; i < s.length; i++) {
          text += s[i]
          pos.push({ x: lead + i + 1, y: row })
        }
      }

      const taken: [number, number][] = []
      const links: ILink[] = []
      for (const { re, kind } of PATTERNS) {
        re.lastIndex = 0
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const a = m.index
          const b = a + m[0].length - 1
          if (taken.some(([s, e]) => a <= e && b >= s)) continue
          taken.push([a, b])
          const start = pos[a]
          const end = pos[b]
          if (start.y > y || end.y < y) continue // only links touching this row
          const value = m[1]
          links.push({
            range: { start, end },
            text: m[0],
            decorations: { underline: true, pointerCursor: true },
            activate: () => void open(kind, value)
          })
        }
      }
      callback(links.length ? links : undefined)
    }
  })
}
