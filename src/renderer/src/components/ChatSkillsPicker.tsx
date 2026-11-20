import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '@shared/types'
import { useChatStore } from '../store/useChatStore'

/** Puzzle piece: skills. */
function IconSkills(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Skills">
      <path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7z" />
    </svg>
  )
}

/**
 * The skills one chat may use, picked from the agent's installed (and turned
 * on) personal skills. Off by default; each chat has its own selection.
 */
export function ChatSkillsPicker({
  agent,
  selected,
  disabled,
  onChange
}: {
  agent: AgentKind
  selected: string[]
  disabled: boolean
  onChange: (names: string[]) => void
}): JSX.Element | null {
  const all = useChatStore((s) => s.skills[agent])
  const loadSkills = useChatStore((s) => s.loadSkills)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadSkills(agent)
  }, [agent, loadSkills])

  // Close when clicking elsewhere or pressing Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (typeof window.fleet.listSkills !== 'function') return null

  const usable = (all ?? []).filter((s) => s.scope === 'personal' && s.enabled)
  const names = new Set(usable.map((s) => s.name))
  // Chosen earlier but since removed or turned off: shown so they can be unticked.
  const gone = selected.filter((n) => !names.has(n))
  const count = selected.filter((n) => names.has(n)).length

  const toggle = (name: string, on: boolean): void => {
    onChange(on ? [...selected, name] : selected.filter((n) => n !== name))
  }

  const manage = (): void => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent('fleet:open-settings', { detail: { section: 'skills' } }))
  }

  return (
    <div className="chat-skills" ref={box}>
      <button
        type="button"
        className={`agent-field chat-skills-btn ${count ? 'on' : ''}`}
        disabled={disabled}
        onClick={() => {
          if (!open) void loadSkills(agent)
          setOpen(!open)
        }}
        title="Skills this chat may use"
      >
        <IconSkills />
        <span>{count ? `${count} skill${count === 1 ? '' : 's'}` : 'Skills'}</span>
      </button>
      {open && (
        <div className="chat-skills-menu" role="dialog" aria-label="Skills for this chat">
          <div className="chat-skills-head">Skills for this chat</div>
          {all === undefined ? (
            <div className="chat-skills-empty"><span className="spinner sm" />Loading…</div>
          ) : usable.length === 0 && gone.length === 0 ? (
            <div className="chat-skills-empty">You haven't installed any skills for this agent yet.</div>
          ) : (
            <div className="chat-skills-list">
              {usable.map((s) => (
                <label key={s.name} className="chat-skills-item" title={s.description}>
                  <input type="checkbox" checked={selected.includes(s.name)} onChange={(e) => toggle(s.name, e.target.checked)} />
                  <span>
                    <b>{s.name}</b>
                    <small>{s.description}</small>
                  </span>
                </label>
              ))}
              {gone.map((n) => (
                <label key={n} className="chat-skills-item gone">
                  <input type="checkbox" checked onChange={() => toggle(n, false)} />
                  <span>
                    <b>{n}</b>
                    <small>Removed or turned off in Settings, so this chat can't use it.</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {agent === 'codex' && usable.length > 0 && (
            <div className="chat-skills-note">Codex chats get a skill's instructions only, not its other files.</div>
          )}
          <button type="button" className="chat-link chat-skills-manage" onClick={manage}>Manage skills…</button>
        </div>
      )}
    </div>
  )
}
