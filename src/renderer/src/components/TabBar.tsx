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
export function TabBar({ projectId, onNewTab }: { projectId: string; onNewTab: () => void }): JSX.Element {
  const tabs = useStore((s) => s.tabs.filter((t) => t.projectId === projectId))
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const activeTabId = useStore((s) => s.activeTabId)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)

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
          title={`${t.branch} · ${t.model} · ${t.permissionMode}`}
        >
          <span className={`status-dot ${t.status}`} />
          <span className="tab-title">{t.title}</span>
          <span className="tab-status">{STATUS_LABEL[t.status]}</span>
          <button className="tab-close" onClick={(e) => { e.stopPropagation(); void onClose(t) }}>×</button>
        </div>
      ))}
      <button className="tab-new" onClick={onNewTab} title="New agent tab">＋</button>
    </div>
  )
}
