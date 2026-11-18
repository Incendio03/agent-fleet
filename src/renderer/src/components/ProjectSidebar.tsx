import { useStore } from '../store/useStore'
import { useState } from 'react'
import { AuthBar } from './AuthBar'
import { SettingsDialog } from './SettingsDialog'

/** Left rail: the list of projects, plus an add button. */
export function ProjectSidebar({
  onNewProject,
  onEditProject
}: {
  onNewProject: () => void
  onEditProject: (projectId: string) => void
}): JSX.Element {
  const projects = useStore((s) => s.projects)
  const [showSettings, setShowSettings] = useState(false)
  const loading = useStore((s) => s.loading)
  const tabs = useStore((s) => s.tabs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const selectProject = useStore((s) => s.selectProject)
  const removeProject = useStore((s) => s.removeProject)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">⚓ Agent Fleet</span>
        <span className="version" title="App version">v{__APP_VERSION__}</span>
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      <div className="project-list">
        {loading ? (
          <div className="empty-hint"><span className="spinner sm" /> Loading…</div>
        ) : (
          projects.length === 0 && <div className="empty-hint">No projects yet.</div>
        )}
        {projects.map((p) => {
          const count = tabs.filter((t) => t.projectId === p.id).length
          const running = tabs.filter((t) => t.projectId === p.id && t.status === 'running').length
          return (
            <div
              key={p.id}
              className={`project-item ${activeProjectId === p.id ? 'active' : ''}`}
              onClick={() => selectProject(p.id)}
              onContextMenu={(e) => { e.preventDefault(); onEditProject(p.id) }}
            >
              <div className="project-name" title={p.localPath}>{p.name}</div>
              <div className="project-meta">
                {count} tab{count === 1 ? '' : 's'}
                {running > 0 && <span className="dot running" title={`${running} running`} />}
              </div>
              <button
                className="project-edit"
                title="Edit project"
                onClick={(e) => { e.stopPropagation(); onEditProject(p.id) }}
              >
                ⋮
              </button>
              <button
                className="project-remove"
                title="Remove project"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Remove project "${p.name}"? This closes its tabs (your files are untouched).`)) {
                    void removeProject(p.id)
                  }
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      <button className="btn add-project" onClick={onNewProject}>+ New project</button>
      <AuthBar />
      <button className="sidebar-settings" onClick={() => setShowSettings(true)} title="Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        <span>Settings</span>
      </button>
    </aside>
  )
}
