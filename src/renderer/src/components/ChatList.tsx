import { Fragment, useState } from 'react'
import type { Chat } from '@shared/types'
import { NEW_CHAT, useChatStore } from '../store/useChatStore'
import { initials } from '../lib/initials'

/** Chats grouped by when they were last used (they arrive newest first). */
function byRecency(chats: Chat[]): { label: string; chats: Chat[] }[] {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const day = 86_400_000
  const since: [string, number][] = [
    ['Today', today],
    ['Yesterday', today - day],
    ['Previous 7 days', today - 7 * day],
    ['Previous 30 days', today - 30 * day],
    ['Older', -Infinity]
  ]
  const groups = since.map(([label]) => ({ label, chats: [] as Chat[] }))
  for (const c of chats) groups[since.findIndex(([, from]) => c.updatedAt >= from)].chats.push(c)
  return groups.filter((g) => g.chats.length > 0)
}

/**
 * The sidebar's Chats section: a New chat button and your chats, newest first,
 * grouped by day. It has the whole sidebar to itself (the Projects | Chats
 * switch above picks which section shows). Collapsed sidebar: each chat is a
 * round initials badge, with its name on hover.
 */
export function ChatList({ collapsed }: { collapsed: boolean }): JSX.Element {
  const available = useChatStore((s) => s.available)
  const chats = useChatStore((s) => s.chats)
  const activeId = useChatStore((s) => s.activeChatId)
  const live = useChatStore((s) => s.live)
  const unread = useChatStore((s) => s.unread)
  const select = useChatStore((s) => s.select)
  const startNew = useChatStore((s) => s.startNew)
  const rename = useChatStore((s) => s.rename)
  const remove = useChatStore((s) => s.remove)
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')

  if (collapsed) {
    return (
      <div className="chat-rail">
        <button className="rail-btn" onClick={startNew} disabled={!available} title="New chat" aria-label="New chat">+</button>
        {chats.map((c) => (
          <button
            key={c.id}
            className={`chat-badge ${activeId === c.id ? 'active' : ''}`}
            onClick={() => select(c.id)}
            title={live[c.id] ? `${c.title}\nReplying…` : unread[c.id] ? `${c.title}\nNew reply` : c.title}
          >
            {initials(c.title)}
            {live[c.id] ? <span className="badge-dot busy" /> : unread[c.id] ? <span className="badge-dot" /> : null}
          </button>
        ))}
      </div>
    )
  }

  const commit = (chatId: string, current: string): void => {
    setEditing(null)
    const title = value.trim()
    if (title && title !== current) void rename(chatId, title)
  }

  const item = (c: Chat): JSX.Element => (
    <div
      key={c.id}
      className={`chat-item ${activeId === c.id ? 'active' : ''}`}
      onClick={() => select(c.id)}
      onContextMenu={(e) => { e.preventDefault(); setValue(c.title); setEditing(c.id) }}
      title={c.title}
    >
      {editing === c.id ? (
        <input
          className="chat-item-input"
          autoFocus
          value={value}
          maxLength={80}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => commit(c.id, c.title)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(c.id, c.title)
            else if (e.key === 'Escape') setEditing(null)
          }}
        />
      ) : (
        <>
          <span className="chat-item-title">{c.title}</span>
          {live[c.id] ? (
            <span className="spinner sm chat-item-busy" title="Replying…" />
          ) : (
            unread[c.id] && <span className="chat-item-dot" title="New reply" />
          )}
          <button
            className="chat-item-btn"
            title="Rename chat"
            onClick={(e) => { e.stopPropagation(); setValue(c.title); setEditing(c.id) }}
          >
            ⋮
          </button>
          <button
            className="chat-item-btn danger"
            title="Delete chat"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete the chat "${c.title}"?\n\nThis can't be undone.`)) void remove(c.id)
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="chat-section">
      <button
        className={`btn add-chat ${activeId === NEW_CHAT ? 'active' : ''}`}
        onClick={startNew}
        disabled={!available}
      >
        + New chat
      </button>
      <div className="chat-list">
        {!available ? (
          <div className="empty-hint">Restart the app to start using chats.</div>
        ) : (
          chats.length === 0 && <div className="empty-hint">No chats yet.</div>
        )}
        {byRecency(chats).map((g) => (
          <Fragment key={g.label}>
            <div className="chat-group">{g.label}</div>
            {g.chats.map(item)}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
