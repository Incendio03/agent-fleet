import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { useChatStore } from '../store/useChatStore'
import { AuthBar } from './AuthBar'
import { ChatList } from './ChatList'
import { SettingsDialog, type SectionId } from './SettingsDialog'
import { isCloudEnabled } from '../lib/supabase'
import { initials } from '../lib/initials'

const COLLAPSE_KEY = 'fleet.sidebar.collapsed'

/** Stable colour per project (from its id), so each badge is recognisable. */
function badgeColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 45% 42%)`
}

const icon = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function GearIcon(): JSX.Element {
  return (
    <svg {...icon}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

/** Folder: the Projects section. */
function ProjectsIcon(): JSX.Element {
  return (
    <svg {...icon}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

/** Speech bubble: the Chats section. */
function ChatsIcon(): JSX.Element {
  return (
    <svg {...icon}>
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" />
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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * Left bar. A switch at the top picks its section, and each section has the
 * whole bar to itself, so a long project list never crowds the chats:
 *   Projects  the projects, with a new-project button (the workspace shows the
 *             selected project's agents);
 *   Chats     the general chats (the workspace shows the selected chat).
 * The section follows what's on screen: opening a chat shows Chats, selecting a
 * project shows Projects. Below: account and settings. Collapses to an icon
 * rail where projects and chats are initials badges (name on hover).
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
  // A chat on screen means the Chats section; otherwise Projects.
  const chatOpen = useChatStore((s) => s.activeChatId !== null)
  const chatsAvailable = useChatStore((s) => s.available)
  const openChats = useChatStore((s) => s.open)
  const selectChat = useChatStore((s) => s.select)
  const unreadChats = useChatStore((s) => Object.keys(s.unread).length)
  const chatsReplying = useChatStore((s) => Object.keys(s.live).length > 0)
  // Open on which section (false = closed).
  const [showSettings, setShowSettings] = useState<SectionId | false>(false)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })

  // Other parts of the UI (e.g. a chat with no agent signed in) can ask for Settings.
  useEffect(() => {
    const open = (e: Event): void => setShowSettings((e as CustomEvent<{ section?: SectionId }>).detail?.section ?? 'agents')
    window.addEventListener('fleet:open-settings', open)
    return () => window.removeEventListener('fleet:open-settings', open)
  }, [])

  const closeSettings = (): void => {
    setShowSettings(false)
    // Someone may just have signed in or out of an agent: chats need to know.
    const { agents } = useStore.getState()
    void useChatStore.getState().refreshAgents(agents.filter((a) => a.available).map((a) => a.id), true)
  }

  const toggle = (): void => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* ignore */ }
      return !c
    })
  }

  // What the other section wants you to know while you're not looking at it.
  const waiting = tabs.filter((t) => attention[t.id]).length
  const urgent = tabs.some((t) => attention[t.id] && attention[t.id].kind !== 'done')

  const scope = account ? 'Your account' : 'This computer'
  const scopeTip = chatOpen
    ? account
      ? `Chats of ${account.email ?? 'your account'}. They are kept on this computer and aren't synced to your other devices yet.`
      : "Chats saved on this computer. Sign in to see your account's chats."
    : account
      ? `Projects in ${account.email ?? 'your account'}, synced across your devices.`
      : "Projects saved on this computer only. Sign in to see your account's projects."

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
      {showSettings && <SettingsDialog initial={showSettings} onClose={closeSettings} />}

      <nav className="sidebar-nav" aria-label="Sections">
        <button
          className={`sidebar-nav-btn ${chatOpen ? '' : 'active'}`}
          aria-pressed={!chatOpen}
          onClick={() => selectChat(null)}
          title={chatOpen && waiting > 0 ? `Projects\n${plural(waiting, 'agent wants', 'agents want')} your attention` : 'Projects and their agents'}
        >
          <ProjectsIcon />
          {!collapsed && <span>Projects</span>}
          {chatOpen && waiting > 0 && <span className={`attention-pill ${urgent ? 'urgent' : ''}`}>{waiting}</span>}
        </button>
        <button
          className={`sidebar-nav-btn ${chatOpen ? 'active' : ''}`}
          aria-pressed={chatOpen}
          disabled={!chatsAvailable}
          onClick={openChats}
          title={
            !chatsAvailable
              ? 'Restart the app to start using chats'
              : !chatOpen && unreadChats > 0
                ? `Chats\n${plural(unreadChats, 'chat has', 'chats have')} a new reply`
                : 'Chats'
          }
        >
          <ChatsIcon />
          {!collapsed && <span>Chats</span>}
          {!chatOpen &&
            (unreadChats > 0 ? (
              <span className="attention-pill">{unreadChats}</span>
            ) : (
              chatsReplying && <span className="spinner sm" />
            ))}
        </button>
      </nav>

      {/* Which set this is: the account's, or this computer's (signed out). */}
      {isCloudEnabled && !collapsed && !loading && (
        <div className="project-scope" title={scopeTip}>{scope}</div>
      )}

      {chatOpen ? (
        <ChatList collapsed={collapsed} />
      ) : (
        <>
          <div className="project-list">
            {loading ? (
              <div className="empty-hint"><span className="spinner sm" />{!collapsed && ' Loading…'}</div>
            ) : (
              projects.length === 0 && !collapsed && <div className="empty-hint">No projects yet.</div>
            )}
            {projects.map((p) => {
              const count = tabs.filter((t) => t.projectId === p.id).length
              const running = tabs.filter((t) => t.projectId === p.id && t.status === 'running').length
              const waitingHere = tabs.filter((t) => t.projectId === p.id && attention[t.id]).length
              const urgentHere = tabs.some((t) => t.projectId === p.id && attention[t.id] && attention[t.id].kind !== 'done')
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
                      {waitingHere > 0 && <span className={`badge-count ${urgentHere ? 'urgent' : ''}`}>{waitingHere}</span>}
                    </span>
                  ) : (
                    <>
                      <div className="project-name">{p.name}</div>
                      <div className="project-meta">
                        {count} tab{count === 1 ? '' : 's'}
                        {running > 0 && <span className="dot running" title={`${running} running`} />}
                        {waitingHere > 0 && (
                          <span className={`attention-pill ${urgentHere ? 'urgent' : ''}`} title={`${waitingHere} agent${waitingHere === 1 ? '' : 's'} want${waitingHere === 1 ? 's' : ''} your attention`}>
                            {waitingHere}
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
        </>
      )}

      <AuthBar compact={collapsed} />
      <button className="sidebar-settings" onClick={() => setShowSettings('agents')} title="Settings">
        <GearIcon />
        {!collapsed && <span>Settings</span>}
      </button>
    </aside>
  )
}
