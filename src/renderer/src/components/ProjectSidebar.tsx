import { useStore } from '../store/useStore'
import { AuthBar } from './AuthBar'

/** Left rail: the list of projects, plus an add button. */
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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">⚓ Agent Fleet</span>
        <span className="version" title="App version">v{__APP_VERSION__}</span>
      </div>

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
    </aside>
  )
}
