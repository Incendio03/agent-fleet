import { useEffect, useRef, useState } from 'react'
import type { FleetMessage } from '@shared/types'
import { useStore } from '../store/useStore'
import { BrowserPanel } from './BrowserPanel'

type View = 'browser' | 'board' | 'messages'

const readView = (): View => {
  try {
    const v = localStorage.getItem('fleet.side.view')
    return v === 'board' || v === 'messages' ? v : 'browser'
  } catch {
    return 'browser'
  }
}

/** Right-hand panel: Browser, the project's Fleet board, and agent messages. */
export function SidePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [view, setView] = useState<View>(readView)
  const projectId = useStore((s) => s.activeProjectId)

  const pick = (v: View): void => {
    setView(v)
    try { localStorage.setItem('fleet.side.view', v) } catch { /* ignore */ }
  }

  return (
    <div className="side-panel">
      <div className="side-tabs">
        {(['browser', 'board', 'messages'] as View[]).map((v) => (
          <button key={v} className={`side-tab ${view === v ? 'active' : ''}`} onClick={() => pick(v)}>
            {v === 'browser' ? 'Browser' : v === 'board' ? 'Board' : 'Messages'}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close panel">✕</button>
      </div>
      {/* Browser stays mounted so the page survives switching views. */}
      <div className="side-body" style={{ display: view === 'browser' ? 'flex' : 'none' }}>
        <BrowserPanel onClose={onClose} />
      </div>
      {view === 'board' && (
        <div className="side-body">
          {projectId ? <BoardView key={projectId} projectId={projectId} /> : <NoProject />}
        </div>
      )}
      {view === 'messages' && (
        <div className="side-body">
          {projectId ? <MessagesView key={projectId} projectId={projectId} /> : <NoProject />}
        </div>
      )}
    </div>
  )
}

function NoProject(): JSX.Element {
  return <div className="side-empty">Select a project first.</div>
}

/** Editor for <project>/.fleet/board.md. Picks up agents' edits while you aren't typing. */
function BoardView({ projectId }: { projectId: string }): JSX.Element {
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (dirtyRef.current) return
      try {
        const t = await window.fleet.readBoard(projectId)
        if (alive && !dirtyRef.current) setText(t)
      } catch (e) {
        if (alive) setStatus((e as Error).message)
      }
    }
    void load()
    const iv = setInterval(() => void load(), 3000)
    return () => { alive = false; clearInterval(iv) }
  }, [projectId])

  const save = async (): Promise<void> => {
    try {
      await window.fleet.writeBoard(projectId, text)
      setDirty(false)
      setStatus('Saved')
      setTimeout(() => setStatus(''), 1500)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  return (
    <div className="board">
      <div className="board-bar">
        <span className="board-path">.fleet/board.md</span>
        <span className="board-status">{dirty ? 'Unsaved changes' : status}</span>
        <button className="btn sm outline" disabled={!dirty} onClick={() => void save()}>Save</button>
      </div>
      <textarea
        className="board-text"
        value={text}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
        }}
      />
      <div className="board-hint">
        Every agent in this project is told to read this board and keep its own section current.
        Agents' edits appear here while you're not typing.
      </div>
    </div>
  )
}

/** Live list of agent-to-agent messages in the project. */
function MessagesView({ projectId }: { projectId: string }): JSX.Element {
  const [msgs, setMsgs] = useState<FleetMessage[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const tabs = useStore((s) => s.tabs)
  const selectTab = useStore((s) => s.selectTab)
  const listRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [m, n] = await Promise.all([window.fleet.listMessages(projectId), window.fleet.sessionNames(projectId)])
        if (alive) { setMsgs(m); setNames(n) }
      } catch { /* ignore */ }
    }
    void load()
    const iv = setInterval(() => void load(), 2000)
    return () => { alive = false; clearInterval(iv) }
  }, [projectId])

  // Keep pinned to the newest message unless you scrolled up.
  useEffect(() => {
    const el = listRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  // session name -> tab title, for friendly labels
  const titleByName: Record<string, string> = {}
  for (const [tabId, name] of Object.entries(names)) {
    const t = tabs.find((x) => x.id === tabId)
    if (t) titleByName[name] = t.title
  }
  const label = (name: string): string => titleByName[name.replace(/\s*\[.*\]$/, '')] ?? name
  const team = Object.entries(names)
    .map(([tabId, name]) => ({ tabId, name, title: tabs.find((t) => t.id === tabId)?.title ?? name }))

  return (
    <div className="messages">
      <div className="team-roster">
        {team.length === 0 ? (
          <span className="side-empty-inline">No agents in this project yet.</span>
        ) : (
          team.map((m) => (
            <button key={m.tabId} className="team-chip" onClick={() => selectTab(m.tabId)} title={`Session name: ${m.name}`}>
              <b>{m.title}</b> <code>{m.name}</code>
            </button>
          ))
        )}
      </div>
      <div
        className="message-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {msgs.length === 0 ? (
          <div className="side-empty">
            No messages yet. Ask an agent to message a teammate, e.g. "send the Code Reviewer a
            summary of your change and ask for a review".
          </div>
        ) : (
          msgs.map((m) => (
            <div key={m.id} className="message">
              <div className="message-head">
                <b>{label(m.from)}</b> <span className="message-arrow">→</span> <b>{label(m.to)}</b>
                <span className="message-time">{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="message-text">{m.text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
