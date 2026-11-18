import { useState } from 'react'
import { AgentsSettings } from './AgentsSettings'
import { NotificationSettings } from './NotificationSettings'

/** Settings sections. Add new ones here (id, label, component). */
const SECTIONS = [
  { id: 'agents', label: 'Agents', render: () => <AgentsSettings /> },
  { id: 'notifications', label: 'Notifications', render: () => <NotificationSettings /> }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** App settings window: a section list on the left, the chosen section on the right. */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [section, setSection] = useState<SectionId>('agents')
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
