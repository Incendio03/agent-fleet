import { useState } from 'react'
import { AgentsSettings } from './AgentsSettings'
import { NotificationSettings } from './NotificationSettings'
import { TerminalSettings } from './TerminalSettings'
import { SkillsSettings } from './SkillsSettings'

/** Settings sections. Add new ones here (id, label, component). */
const SECTIONS = [
  { id: 'agents', label: 'Agents', render: () => <AgentsSettings /> },
  { id: 'skills', label: 'Skills', render: () => <SkillsSettings /> },
  { id: 'notifications', label: 'Notifications', render: () => <NotificationSettings /> },
  { id: 'terminal', label: 'Terminal', render: () => <TerminalSettings /> }
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/** App settings window: a section list on the left, the chosen section on the right. */
export function SettingsDialog({ onClose, initial }: { onClose: () => void; initial?: SectionId }): JSX.Element {
  const [section, setSection] = useState<SectionId>(initial ?? 'agents')
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <h2>Settings</h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${s.id === section ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {current.render()}
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}
