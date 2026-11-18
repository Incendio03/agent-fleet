import { useStore } from '../store/useStore'
import type { Tab, TabStatus } from '@shared/types'

const STATUS_LABEL: Record<TabStatus, string> = {
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  exited: 'done',
  error: 'error'
}

/** Top bar of tabs for the active project, plus the new-tab button. */
export function TabBar({
  projectId,
  onNewTab,
  onEditTab,
  browserOpen,
  onToggleBrowser
}: {
  projectId: string
  onNewTab: () => void
  onEditTab: (tabId: string) => void
  browserOpen: boolean
  onToggleBrowser: () => void
}): JSX.Element {
  const tabs = useStore((s) => s.tabs.filter((t) => t.projectId === projectId))
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const activeTabId = useStore((s) => s.activeTabId)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)
  const busy = useStore((s) => s.busy)
  const attention = useStore((s) => s.attention)

  const onClose = async (tab: Tab): Promise<void> => {
    const isolated = project != null && tab.worktreePath !== project.localPath
    const msg = isolated
      ? `Close "${tab.title}"?\n\nThis stops the agent and removes its worktree folder.\nBranch "${tab.branch}" is kept so you don't lose committed work.`
      : `Close "${tab.title}"?\n\nThis stops the agent. Your project folder is left untouched.`
    if (confirm(msg)) await closeTab(tab.id, false)
  }

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${activeTabId === t.id ? 'active' : ''}`}
          onClick={() => selectTab(t.id)}
          onDoubleClick={() => onEditTab(t.id)}
          onContextMenu={(e) => { e.preventDefault(); onEditTab(t.id) }}
          title={`${t.branch} · ${t.model} · ${t.permissionMode}`}
        >
          <TabIndicator status={t.status} busy={!!busy[t.id]} attention={attention[t.id]?.kind} />
          <span className="tab-title">{t.title}</span>
          <span className={`tab-status ${attention[t.id]?.kind ?? ''}`} title={attention[t.id]?.message}>
            {attention[t.id]?.kind === 'input'
              ? 'needs you'
              : attention[t.id]?.kind === 'error'
                ? 'error'
                : busy[t.id]
                  ? 'working'
                  : attention[t.id]?.kind === 'done'
                    ? 'done'
                    : STATUS_LABEL[t.status]}
          </span>
          <button className="tab-edit" title="Edit agent" onClick={(e) => { e.stopPropagation(); onEditTab(t.id) }}>⋮</button>
          <button className="tab-close" onClick={(e) => { e.stopPropagation(); void onClose(t) }}>×</button>
        </div>
      ))}
      <button className="tab-new" onClick={onNewTab} title="New agent tab">＋</button>
      <span style={{ flex: 1 }} />
      <button
        className={`tab-new browser-toggle ${browserOpen ? 'on' : ''}`}
        onClick={onToggleBrowser}
        title={browserOpen ? 'Hide side panel' : 'Browser, board and messages'}
      >
        🌐
      </button>
    </div>
  )
}

/** Tab icon: ! needs you, ✓ finished unseen, spinner working, else the status dot. */
function TabIndicator({
  status,
  busy,
  attention
}: {
  status: TabStatus
  busy: boolean
  attention?: 'done' | 'input' | 'error'
}): JSX.Element {
  if (attention === 'input') return <span className="tab-badge input" title="Needs you">!</span>
  if (attention === 'error') return <span className="tab-badge error" title="Stopped with an error">!</span>
  if (busy) return <span className="spinner sm tab-spinner" title="Working" />
  if (attention === 'done') return <span className="tab-badge done" title="Finished">✓</span>
  return <span className={`status-dot ${status}`} />
}
