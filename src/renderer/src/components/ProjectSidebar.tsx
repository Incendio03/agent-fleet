import { useState } from 'react'
import { useStore } from '../store/useStore'
import { AuthBar } from './AuthBar'
import { SettingsDialog } from './SettingsDialog'
import { isCloudEnabled } from '../lib/supabase'

const COLLAPSE_KEY = 'fleet.sidebar.collapsed'

/** "Office Anesthesia" -> "OA", "agent-fleet" -> "AF", "web" -> "WE". */
function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

/** Stable colour per project (from its id), so each badge is recognisable. */
function badgeColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 45% 42%)`
}

function GearIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

/** « / » chevrons for collapsing the sidebar. */
function CollapseIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {collapsed ? <path d="M6 17l5-5-5-5M13 17l5-5-5-5" /> : <path d="M18 17l-5-5 5-5M11 17l-5-5 5-5" />}
    </svg>
  )
}

/**
 * Left rail: projects, new-project button, account and settings. Collapses to
 * an icon rail where each project is an initials badge (name on hover).
 */
export function ProjectSidebar({
  onNewProject,
  onEditProject
}: {
  onNewProject: () => void
  onEditProject: (projectId: string) => void
}): JSX.Element {
  const projects = useStore((s) => s.projects)
  const loading = useStore((s) => s.loading)
  const tabs = useStore((s) => s.tabs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const selectProject = useStore((s) => s.selectProject)
  const removeProject = useStore((s) => s.removeProject)
  const attention = useStore((s) => s.attention)
  const account = useStore((s) => s.account)
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })

  const toggle = (): void => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* ignore */ }
      return !c
    })
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {collapsed ? (
          <button className="brand-mark" onClick={toggle} title="Expand sidebar">⚓</button>
        ) : (
          <>
            <span className="brand">⚓ Agent Fleet</span>
            <span className="version" title="App version">v{__APP_VERSION__}</span>
            <button className="icon-btn sidebar-toggle" onClick={toggle} title="Collapse sidebar">
              <CollapseIcon collapsed={false} />
            </button>
          </>
        )}
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      <div className="project-list">
        {/* Which set this is: the account's (synced) or this computer's. */}
        {isCloudEnabled && !collapsed && !loading && (
          <div
            className="project-scope"
            title={
              account
                ? `Projects in ${account.email ?? 'your account'}, synced across your devices.`
                : "Projects saved on this computer only. Sign in to see your account's projects."
            }
          >
            {account ? 'Your account' : 'This computer'}
          </div>
        )}
        {loading ? (
          <div className="empty-hint"><span className="spinner sm" />{!collapsed && ' Loading…'}</div>
        ) : (
          projects.length === 0 && !collapsed && <div className="empty-hint">No projects yet.</div>
        )}
        {projects.map((p) => {
          const count = tabs.filter((t) => t.projectId === p.id).length
          const running = tabs.filter((t) => t.projectId === p.id && t.status === 'running').length
          const waiting = tabs.filter((t) => t.projectId === p.id && attention[t.id]).length
          const urgent = tabs.some((t) => t.projectId === p.id && attention[t.id] && attention[t.id].kind !== 'done')
          const tip = `${p.name}\n${count} tab${count === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}\n${p.localPath}`
          return (
            <div
              key={p.id}
              className={`project-item ${activeProjectId === p.id ? 'active' : ''}`}
              onClick={() => selectProject(p.id)}
              onContextMenu={(e) => { e.preventDefault(); onEditProject(p.id) }}
              title={collapsed ? tip : p.localPath}
            >
              {collapsed ? (
                <span className="project-badge" style={{ background: badgeColor(p.id) }}>
                  {initials(p.name)}
                  {running > 0 && <span className="badge-dot" />}
                  {waiting > 0 && <span className={`badge-count ${urgent ? 'urgent' : ''}`}>{waiting}</span>}
                </span>
              ) : (
                <>
                  <div className="project-name">{p.name}</div>
                  <div className="project-meta">
                    {count} tab{count === 1 ? '' : 's'}
                    {running > 0 && <span className="dot running" title={`${running} running`} />}
                    {waiting > 0 && (
                      <span className={`attention-pill ${urgent ? 'urgent' : ''}`} title={`${waiting} agent${waiting === 1 ? '' : 's'} want${waiting === 1 ? 's' : ''} your attention`}>
                        {waiting}
                      </span>
                    )}
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
                </>
              )}
            </div>
          )
        })}
      </div>

      {collapsed ? (
        <button className="rail-btn" onClick={onNewProject} title="New project">+</button>
      ) : (
        <button className="btn add-project" onClick={onNewProject}>+ New project</button>
      )}
      <AuthBar compact={collapsed} />
      <button className="sidebar-settings" onClick={() => setShowSettings(true)} title="Settings">
        <GearIcon />
        {!collapsed && <span>Settings</span>}
      </button>
    </aside>
  )
}
