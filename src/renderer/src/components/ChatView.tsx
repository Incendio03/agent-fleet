import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentInfo, Chat, ChatLive, ChatMessage } from '@shared/types'
import { useStore } from '../store/useStore'
import { NEW_CHAT, useChatStore } from '../store/useChatStore'
import { ChatInput, chatAgentLabel } from './ChatInput'
import { Markdown } from './Markdown'

/**
 * A general chat on screen: the conversation (your messages as bubbles, replies
 * as formatted text that streams in), and the message box. Shown instead of the
 * project view while a chat is selected in the sidebar.
 */
export function ChatView(): JSX.Element {
  const activeId = useChatStore((s) => s.activeChatId)
  const chat = useChatStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  const messages = useChatStore((s) => (s.activeChatId ? s.messages[s.activeChatId] : undefined))
  const live = useChatStore((s) => (s.activeChatId ? s.live[s.activeChatId] : undefined))
  const error = useChatStore((s) => s.error)
  const setError = useChatStore((s) => s.setError)
  const retry = useChatStore((s) => s.retry)
  const refreshAgents = useChatStore((s) => s.refreshAgents)
  const agents = useStore((s) => s.agents)

  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  /** Follow new text only while you're at the bottom; scrolling up to read holds the view still. */
  const follow = useRef(true)
  const [away, setAway] = useState(false)

  const toEnd = (): void => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Opening a chat starts at its newest message.
  useLayoutEffect(() => {
    follow.current = true
    setAway(false)
    toEnd()
  }, [activeId])

  useLayoutEffect(() => {
    if (follow.current) toEnd()
  }, [messages, live?.text, live?.status])

  // Late layout changes (an image finishing loading, the window resizing) too.
  useEffect(() => {
    const el = column.current
    if (!el) return
    const ro = new ResizeObserver(() => { if (follow.current) toEnd() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Which agents are signed in decides who can answer; check when chat is opened.
  useEffect(() => {
    void refreshAgents(agents.filter((a) => a.available).map((a) => a.id))
  }, [agents, refreshAgents])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 80
    follow.current = !far
    setAway(far)
  }

  const loading = Boolean(chat) && messages === undefined
  const empty = !loading && !live && (messages?.length ?? 0) === 0
  const last = messages?.[messages.length - 1]

  return (
    <div className="chat-view">
      <ChatHeader chat={chat} />

      <div className="chat-body">
        <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
          <div className="chat-col" ref={column}>
            {loading && <div className="chat-loading"><span className="spinner sm" />Loading…</div>}
            {empty && (
              <div className="chat-welcome">
                <h1>What can I help with?</h1>
                <p>
                  Ask about anything. Replies come from the agent account you&apos;ve connected and can use
                  web search. A chat can&apos;t see your files or run commands; for work inside a project,
                  use an agent tab there.
                </p>
              </div>
            )}
            {messages?.map((m) => (
              <Message
                key={m.id}
                message={m}
                agents={agents}
                isLast={m === last}
                onRetry={chat && m === last && !live && m.role === 'assistant' && (m.error || m.stopped) ? () => void retry(chat.id) : undefined}
              />
            ))}
            {live && <LiveReply live={live} />}
          </div>
        </div>
        {away && (
          <button
            className="chat-jump"
            title="Jump to the latest message"
            aria-label="Jump to the latest message"
            onClick={() => { follow.current = true; setAway(false); toEnd() }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {error && (
        <div className="chat-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <ChatInput chat={activeId === NEW_CHAT ? undefined : chat} />
    </div>
  )
}

/** The chat's name; click it to rename. */
function ChatHeader({ chat }: { chat: Chat | undefined }): JSX.Element {
  const rename = useChatStore((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  useEffect(() => setEditing(false), [chat?.id])

  const commit = (): void => {
    setEditing(false)
    const title = value.trim()
    if (chat && title && title !== chat.title) void rename(chat.id, title)
  }

  return (
    <header className="chat-head">
      {!chat ? (
        <span className="chat-title static">New chat</span>
      ) : editing ? (
        <input
          className="chat-title-input"
          autoFocus
          value={value}
          maxLength={80}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          className="chat-title"
          title="Rename this chat"
          onClick={() => { setValue(chat.title); setEditing(true) }}
        >
          {chat.title}
        </button>
      )}
    </header>
  )
}

/** Thumbnails already read from disk, by path. */
const thumbs = new Map<string, string>()

/** An image attached to a sent message; click to open it full size. */
function ChatImage({ path }: { path: string }): JSX.Element {
  const [src, setSrc] = useState(() => thumbs.get(path))
  const openImage = useStore((s) => s.openImage)

  useEffect(() => {
    if (src) return
    let alive = true
    window.fleet.readImage(path)
      .then((d) => {
        thumbs.set(path, d)
        if (alive) setSrc(d)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [path, src])

  return src ? (
    <img className="chat-image" src={src} alt="Attached image" title="Open image" onClick={() => void openImage(path)} />
  ) : (
    <span className="chat-image placeholder" />
  )
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="chat-action"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

const Message = memo(function Message({
  message: m,
  agents,
  isLast,
  onRetry
}: {
  message: ChatMessage
  agents: AgentInfo[]
  isLast: boolean
  /** Present when this reply failed or was stopped and can be run again. */
  onRetry?: () => void
}): JSX.Element {
  if (m.role === 'user') {
    return (
      <div className="chat-msg user">
        {m.images && m.images.length > 0 && (
          <div className="chat-images">{m.images.map((p) => <ChatImage key={p} path={p} />)}</div>
        )}
        {m.text && <div className="chat-bubble">{m.text}</div>}
      </div>
    )
  }

  const model = m.model ? agents.find((a) => a.id === m.agent)?.models.find((x) => x.id === m.model)?.label ?? m.model : ''
  return (
    <div className={`chat-msg assistant ${isLast ? 'last' : ''}`}>
      {m.text && <Markdown text={m.text} />}
      {m.error && <div className="chat-error" role="alert">{m.error}</div>}
      <div className="chat-meta">
        {m.stopped && <span className="chat-stopped">Stopped</span>}
        {m.agent && <span className="chat-who">{chatAgentLabel(m.agent, agents)}{model ? ` · ${model}` : ''}</span>}
        {m.text && <CopyButton text={m.text} />}
        {onRetry && <button className="chat-action" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  )
})

/** The reply while it is being written: text so far + what the agent is doing. */
function LiveReply({ live }: { live: ChatLive }): JSX.Element {
  return (
    <div className="chat-msg assistant live">
      {live.text && <Markdown text={live.text} />}
      <div className="chat-status" role="status">
        <span className="spinner sm" />
        {live.status ?? ''}
      </div>
    </div>
  )
}
