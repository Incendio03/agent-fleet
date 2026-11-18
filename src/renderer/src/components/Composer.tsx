import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Tab } from '@shared/types'
import { useStore } from '../store/useStore'
import { AgentBar } from './AgentBar'

/** A file attached to the next message: shown as a chip, sent as its path. */
export interface Attachment {
  path: string
  name: string
  /** Data URL for image thumbnails; undefined for other files. */
  preview?: string
}

/** Unsent text + attachments per tab, kept while you switch tabs (not persisted). */
const drafts = new Map<string, { text: string; files: Attachment[] }>()

/** Mounted composers, so other parts of the UI can add to a tab's draft. */
const listeners = new Map<string, () => void>()

/**
 * Add an attachment (and optionally some text) to a tab's message draft —
 * e.g. from Annotate — so you can review it before sending.
 */
export function attachToComposer(tabId: string, file: Attachment, text?: string): void {
  const d = drafts.get(tabId) ?? { text: '', files: [] }
  const files = d.files.some((f) => f.path === file.path) ? d.files : [...d.files, file]
  const nextText = text ? (d.text.trim() ? `${d.text.replace(/\s+$/, '')} ${text}` : text) : d.text
  drafts.set(tabId, { text: nextText, files })
  listeners.get(tabId)?.()
}

const IMAGE_RE =/\.(png|jpe?g|gif|webp)$/i
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

const ESC = '\x1b'
// Keys forwarded to the agent when the box is EMPTY, so menus stay usable.
const NAV_KEYS: Record<string, string> = {
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  Enter: '\r'
}

/**
 * Chat-style message box under the terminal. Normal text editing (new lines,
 * select all, copy/paste, undo); Enter sends the whole message to the agent.
 * Multi-line messages go as a bracketed paste so their newlines don't submit
 * early. Esc always reaches the agent (interrupt); with an empty box, ↑ ↓
 * Enter and Shift+Tab do too, for answering the agent's menus.
 */
export function Composer({ tab }: { tab: Tab }): JSX.Element {
  const [text, setText] = useState(() => drafts.get(tab.id)?.text ?? '')
  const [files, setFiles] = useState<Attachment[]>(() => drafts.get(tab.id)?.files ?? [])
  const openImage = useStore((s) => s.openImage)
  const ref = useRef<HTMLTextAreaElement>(null)
  const isLive = useStore((s) => s.liveTabIds.has(tab.id))
  const projectId = useStore((s) => s.activeProjectId)
  const setError = useStore((s) => s.setError)
  const [dragOver, setDragOver] = useState(false)

  const update = (v: string): void => {
    setText(v)
    drafts.set(tab.id, { text: v, files })
  }
  const setAttachments = (next: Attachment[]): void => {
    setFiles(next)
    drafts.set(tab.id, { text, files: next })
  }
  const attach = (added: Attachment[]): void => {
    const known = new Set(files.map((f) => f.path))
    setAttachments([...files, ...added.filter((a) => !known.has(a.path))])
    ref.current?.focus()
  }

  // Pick up attachments/text added from elsewhere (e.g. Annotate).
  useEffect(() => {
    listeners.set(tab.id, () => {
      const d = drafts.get(tab.id)
      setText(d?.text ?? '')
      setFiles(d?.files ?? [])
      requestAnimationFrame(() => ref.current?.focus())
    })
    return () => { listeners.delete(tab.id) }
  }, [tab.id])

  // Focus the box when this tab is shown.
  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [tab.id])

  // Auto-grow up to ~10 lines.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const sendRaw = (data: string): void => window.fleet.sendInput(tab.id, data)

  const hasContent = text.trim().length > 0 || files.length > 0

  const send = (): void => {
    if (!hasContent || !isLive) return
    // Attachments travel as quoted paths after the text; the agent opens them.
    const paths = files.map((f) => `"${f.path}"`).join(' ')
    const msg = [text.replace(/\r\n?/g, '\n').replace(/\s+$/, ''), paths].filter(Boolean).join(' ')
    if (msg.includes('\n')) {
      // Bracketed paste: the agent receives the newlines as text, not as Enter.
      sendRaw(`${ESC}[200~${msg}${ESC}[201~`)
    } else {
      sendRaw(msg)
    }
    // Submit separately, a beat later, so it isn't swallowed as part of the paste.
    setTimeout(() => sendRaw('\r'), 60)
    setText('')
    setFiles([])
    drafts.delete(tab.id)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    // Ctrl+V with an image on the clipboard: take over (paste events don't
    // reliably expose screenshots). Text clipboards fall through to native paste.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v' && window.fleet.clipboardHasImage()) {
      e.preventDefault()
      void pasteClipboardImage()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      sendRaw(ESC) // interrupt / dismiss in the agent; draft is kept
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      if (hasContent) send()
      else if (isLive) sendRaw('\r') // empty box: confirm the agent's highlighted option
      return
    }
    // Backspace in an empty box removes the last attachment.
    if (e.key === 'Backspace' && !text && files.length) {
      e.preventDefault()
      setAttachments(files.slice(0, -1))
      return
    }
    if (!text && !files.length && isLive) {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        sendRaw(`${ESC}[Z`) // Shift+Tab: Claude Code cycles its mode
        return
      }
      const seq = NAV_KEYS[e.key]
      if (seq && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        sendRaw(seq)
      }
    }
  }

  const pasteClipboardImage = async (): Promise<void> => {
    try {
      const dataUrl = await window.fleet.readClipboardImage()
      if (!dataUrl) return
      if (!projectId) return setError('Select a project before pasting images.')
      const path = await window.fleet.saveShot(projectId, dataUrl)
      attach([{ path, name: baseName(path), preview: dataUrl }])
    } catch (err) {
      setError(`Could not paste image: ${(err as Error).message}`)
    }
  }

  // Ctrl+V with an image: save it into the project and insert its path.
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const images = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f != null)
    const hasText = e.clipboardData.getData('text/plain').length > 0
    if (!images.length && hasText) return // plain text: default paste
    e.preventDefault()
    try {
      // Images the page can see, else ask the OS clipboard (bitmap-only
      // clipboards such as Win+V history aren't exposed to the paste event).
      const dataUrls = images.length
        ? await Promise.all(images.map(toPngDataUrl))
        : [await window.fleet.readClipboardImage()].filter((d): d is string => d != null)
      if (!dataUrls.length) {
        const formats = await window.fleet.clipboardFormats()
        return setError(`Nothing to paste: the clipboard has no text or image${formats.length ? ` (formats: ${formats.join(', ')})` : ''}.`)
      }
      if (!projectId) return setError('Select a project before pasting images.')
      const added: Attachment[] = []
      for (const d of dataUrls) {
        const path = await window.fleet.saveShot(projectId, d)
        added.push({ path, name: baseName(path), preview: d })
      }
      attach(added)
    } catch (err) {
      setError(`Could not paste image: ${(err as Error).message}`)
    }
  }

  // Drop files: attach them (images get a thumbnail).
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.fleet.pathForFile(f))
      .filter(Boolean)
    const added = await Promise.all(
      paths.map(async (path): Promise<Attachment> => ({
        path,
        name: baseName(path),
        preview: IMAGE_RE.test(path) ? await window.fleet.readImage(path).catch(() => undefined) : undefined
      }))
    )
    if (added.length) attach(added)
  }

  return (
    <div className="composer">
      <div
        className={`composer-box ${dragOver ? 'drag' : ''} ${isLive ? '' : 'disabled'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f) => (
              <div key={f.path} className={`composer-file ${f.preview ? 'image' : ''}`} title={f.path}>
                {f.preview ? (
                  <img src={f.preview} alt={f.name} onClick={() => void openImage(f.path)} />
                ) : (
                  <span className="composer-file-name">📄 {f.name}</span>
                )}
                <button
                  className="composer-file-remove"
                  onClick={() => setAttachments(files.filter((x) => x.path !== f.path))}
                  title="Remove"
                  aria-label={`Remove ${f.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          spellCheck
          placeholder={isLive ? `Message ${tab.title}…` : 'Agent not running. Resume it to send messages.'}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
        />
        <button
          className="composer-send"
          disabled={!isLive || !hasContent}
          onClick={send}
          title="Send (Enter)"
          aria-label="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
        </div>
      </div>
      <div className="composer-foot">
        <AgentBar tab={tab} />
        <span className="composer-hint">Enter to send · Shift+Enter new line · Esc interrupts</span>
      </div>
    </div>
  )
}

/** Any pasted image → PNG data URL (saveShot stores PNGs). */
function toPngDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('unreadable image'))
    }
    img.src = url
  })
}
