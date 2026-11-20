import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentInfo, AgentKind, AgentStatus, Chat } from '@shared/types'
import { useStore } from '../store/useStore'
import { NEW_CHAT, lastChoice, useChatStore, type ChatChoice } from '../store/useChatStore'
import { IconAgent, IconModel, modelOptions } from './AgentBar'
import { ChatSkillsPicker } from './ChatSkillsPicker'

/** An image waiting to be sent with the next message. */
interface PendingImage {
  id: string
  dataUrl: string
}

/** Unsent text + images per chat, kept while you look at something else (not saved to disk). */
const drafts = new Map<string, { text: string; images: PendingImage[] }>()

const MAX_IMAGES = 8
/** Longest edge an attached image is scaled down to (plenty for reading screenshots). */
const MAX_EDGE = 1568

/** In a chat, "Claude Code" (the CLI's name) reads better as just "Claude". */
export const chatAgentLabel = (id: AgentKind, agents: AgentInfo[]): string =>
  id === 'claude' ? 'Claude' : agents.find((a) => a.id === id)?.label ?? id

type Statuses = Partial<Record<AgentKind, AgentStatus>>

/** Can this agent answer right now? Unknown sign-in state counts as yes until checked. */
const usable = (a: AgentInfo, status: Statuses): boolean => a.available && status[a.id]?.loggedIn !== false

/** Agent/model for a new chat: what you used last, else the first connected agent. */
function defaultChoice(agents: AgentInfo[], status: Statuses): ChatChoice | null {
  const ok = agents.filter((a) => usable(a, status))
  const last = lastChoice()
  if (last && ok.some((a) => a.id === last.agent)) return last
  const a = ok[0] ?? agents.find((x) => x.available)
  if (!a) return null
  const model = (a.id === 'claude' ? a.models.find((m) => m.id === 'sonnet') : undefined) ?? a.models[0]
  return { agent: a.id, model: model?.id ?? '' }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('unreadable file'))
    r.readAsDataURL(file)
  })
}

/** Any image (data URL) -> PNG/JPEG data URL, scaled down if it is very large. */
function normalizeImage(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      resolve(/^data:image\/jpe?g/i.test(dataUrl) ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('unreadable image'))
    img.src = dataUrl
  })
}

/**
 * The message box of a general chat: plain typing (Enter sends, Shift+Enter is
 * a new line), pasted/dropped images, Stop while a reply is coming, and the
 * agent + model that answer.
 */
export function ChatInput({ chat }: { chat: Chat | undefined }): JSX.Element {
  const key = chat?.id ?? NEW_CHAT
  const agents = useStore((s) => s.agents)
  const status = useChatStore((s) => s.agentStatus)
  const busy = useChatStore((s) => Boolean(s.live[key]))
  const hasMessages = useChatStore((s) => (s.messages[key]?.length ?? 0) > 0)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const setChoice = useChatStore((s) => s.setChoice)
  const setError = useChatStore((s) => s.setError)

  const [text, setText] = useState(() => drafts.get(key)?.text ?? '')
  const [images, setImages] = useState<PendingImage[]>(() => drafts.get(key)?.images ?? [])
  const [picked, setPicked] = useState<ChatChoice | null>(null) // new chat only
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Another chat came on screen: show its draft. Not while our own send is
  // turning the blank chat into a saved one — then what's in the box stays ours
  // (already cleared, or put back if the send fails).
  const adopting = useRef(false)
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    if (!adopting.current) {
      setText(drafts.get(key)?.text ?? '')
      setImages(drafts.get(key)?.images ?? [])
    }
  }

  // Who answers: the chat's own agent/model, or (new chat) your pick / the default.
  const choice: ChatChoice | null = chat
    ? { agent: chat.agent, model: chat.model, skills: chat.skills ?? [] }
    : picked ?? defaultChoice(agents, status)
  const agent = agents.find((a) => a.id === choice?.agent)
  const anyUsable = agents.some((a) => usable(a, status))
  const ready = Boolean(choice && agent && usable(agent, status))

  useEffect(() => {
    drafts.set(key, { text, images })
  }, [key, text, images])

  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [key])

  // Grow with the text, up to about ten lines.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const addImages = async (sources: string[]): Promise<void> => {
    try {
      const room = MAX_IMAGES - images.length
      if (sources.length > room) setError(`A message can carry up to ${MAX_IMAGES} images.`)
      const added: PendingImage[] = []
      for (const src of sources.slice(0, Math.max(room, 0))) {
        added.push({ id: crypto.randomUUID(), dataUrl: await normalizeImage(src) })
      }
      if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_IMAGES))
    } catch {
      setError('That image could not be read.')
    }
    ref.current?.focus()
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (pics.length < files.length) setError('Only images can be attached to a chat.')
    if (pics.length) await addImages(await Promise.all(pics.map(readAsDataUrl)))
  }

  const hasContent = text.trim().length > 0 || images.length > 0
  const canSend = hasContent && ready && !busy && !sending

  const submit = async (): Promise<void> => {
    if (!canSend || !choice) return
    const draft = { text, images }
    setSending(true)
    adopting.current = true
    setText('')
    setImages([])
    const ok = await send(draft.text, draft.images.map((i) => i.dataUrl), choice)
    adopting.current = false
    setSending(false)
    // A new chat got its id on send: the blank screen's draft is done with.
    drafts.delete(NEW_CHAT)
    if (!ok) {
      // Nothing was sent: put the message back in the box.
      setText(draft.text)
      setImages(draft.images)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    // Ctrl+V with an image on the clipboard: take over (the paste event doesn't
    // reliably carry screenshots). Text clipboards fall through to normal paste.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v' && window.fleet.clipboardHasImage()) {
      e.preventDefault()
      void window.fleet.readClipboardImage().then((d) => (d ? addImages([d]) : undefined))
      return
    }
    if (e.key === 'Escape' && busy && chat) {
      e.preventDefault()
      stop(chat.id)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Backspace' && !text && images.length) {
      e.preventDefault()
      setImages(images.slice(0, -1))
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
      return
    }
    if (e.clipboardData.getData('text/plain')) return // text: normal paste
    // Neither text nor a file: a bitmap-only clipboard (e.g. Win+V history),
    // which the page can't see. Ask the OS clipboard instead.
    e.preventDefault()
    void window.fleet.readClipboardImage().then((d) => {
      if (d) void addImages([d])
      else setError('Nothing to paste: the clipboard has no text or image.')
    })
  }

  const onPick = (next: ChatChoice): void => {
    if (!chat) return setPicked(next)
    if (next.agent !== chat.agent && hasMessages) {
      const label = chatAgentLabel(next.agent, agents)
      if (!confirm(`Continue this chat with ${label}?\n\nThe conversation so far will be sent to ${label}, so it has the context.`)) return
    }
    void setChoice(chat.id, next)
  }

  const onAgent = (id: AgentKind): void => {
    const next = agents.find((a) => a.id === id)
    const model = (id === 'claude' ? next?.models.find((m) => m.id === 'sonnet') : undefined) ?? next?.models[0]
    onPick({ agent: id, model: model?.id ?? '' })
  }

  const models = modelOptions(agent, choice?.model || undefined)
  const placeholder = !anyUsable
    ? 'Connect an agent in Settings to start chatting.'
    : !ready && choice
      ? `${chatAgentLabel(choice.agent, agents)} isn't signed in.`
      : 'Message…'

  const openSettings = (): void => { window.dispatchEvent(new CustomEvent('fleet:open-settings')) }
  // What stands in the way of chatting, if anything. (`agents` is empty until
  // the agent programs have been looked for, so nothing is claimed before that.)
  const notice: [string, string] | null =
    agents.length === 0
      ? null
      : !agents.some((a) => a.available)
        ? ['No agent program is installed on this computer.', ' to see how to install one.']
        : !anyUsable
          ? ['No agent is signed in yet.', ' to connect one. Chats use your own agent account.']
          : choice && !ready
            ? [`${chatAgentLabel(choice.agent, agents)} isn't signed in.`, ' to sign in, or pick another agent below.']
            : null

  return (
    <div className="chat-input">
      {notice && (
        <div className="chat-notice">
          {notice[0]}{' '}
          <button className="chat-link" onClick={openSettings}>Open Settings</button>
          {notice[1]}
        </div>
      )}
      <div
        className={`composer-box ${dragOver ? 'drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void addFiles(Array.from(e.dataTransfer.files))
        }}
      >
        {images.length > 0 && (
          <div className="composer-files">
            {images.map((img) => (
              <div key={img.id} className="composer-file image">
                <img src={img.dataUrl} alt="Attached image" />
                <button
                  className="composer-file-remove"
                  onClick={() => setImages(images.filter((x) => x.id !== img.id))}
                  title="Remove"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button
            className="chat-attach"
            onClick={() => fileRef.current?.click()}
            title="Attach images (or paste / drop them)"
            aria-label="Attach images"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            value={text}
            spellCheck
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {busy && chat ? (
            <button className="composer-send stop" onClick={() => stop(chat.id)} title="Stop (Esc)" aria-label="Stop">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button className="composer-send" disabled={!canSend} onClick={() => void submit()} title="Send (Enter)" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="composer-foot">
        {choice && (
          <div className="agent-bar">
            <label className="agent-field" title="Which of your connected agents answers in this chat">
              <IconAgent />
              <select value={choice.agent} disabled={busy} onChange={(e) => onAgent(e.target.value as AgentKind)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!usable(a, status)}>
                    {chatAgentLabel(a.id, agents)}
                    {!a.available ? ' (not installed)' : status[a.id]?.loggedIn === false ? ' (not signed in)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="agent-field" title="Model">
              <IconModel />
              <select
                value={choice.model}
                disabled={busy || models.length === 0}
                onChange={(e) => onPick({ agent: choice.agent, model: e.target.value, skills: choice.skills ?? [] })}
              >
                {models.length === 0 && <option value="">Default</option>}
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <ChatSkillsPicker
              agent={choice.agent}
              selected={choice.skills ?? []}
              disabled={busy}
              onChange={(skills) => onPick({ agent: choice.agent, model: choice.model, skills })}
            />
          </div>
        )}
        <span className="composer-hint">
          {busy ? 'Esc stops the reply' : 'Enter to send · Shift+Enter new line'}
        </span>
      </div>
    </div>
  )
}
