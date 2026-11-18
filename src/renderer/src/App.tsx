import { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import { startTerminalRouting } from './lib/terminalRegistry'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { NewProjectDialog } from './components/NewProjectDialog'
import { NewTabDialog } from './components/NewTabDialog'

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const projects = useStore((s) => s.projects)
  const tabs = useStore((s) => s.tabs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const activeTabId = useStore((s) => s.activeTabId)

  const [showNewProject, setShowNewProject] = useState(false)
  const [showNewTab, setShowNewTab] = useState(false)

  // Start live terminal routing before any tab mounts, then load saved state.
  useEffect(() => {
    startTerminalRouting()
    void init()
  }, [init])

  const resumeTab = useStore((s) => s.resumeTab)
  const liveTabIds = useStore((s) => s.liveTabIds)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const projectTabs = tabs.filter((t) => t.projectId === activeProjectId)
  const activeTab = projectTabs.find((t) => t.id === activeTabId) ?? null
  // A tab with no live process in this app run can be resumed. Using liveTabIds
  // (not the persisted status) ensures restored tabs always offer Resume instead
  // of showing a blank terminal.
  const canResume = activeTab != null && !liveTabIds.has(activeTab.id)

  return (
    <div className="app">
      <ProjectSidebar onNewProject={() => setShowNewProject(true)} />

      <main className="workspace">
        {loading ? (
          <div className="center-hint">Loading…</div>
        ) : !activeProject ? (
          <div className="center-hint">
            <h1>Welcome to Agent Fleet</h1>
            <p>Create a project to start launching agents.</p>
            <button className="btn primary" onClick={() => setShowNewProject(true)}>+ New project</button>
          </div>
        ) : (
          <>
            <TabBar projectId={activeProject.id} onNewTab={() => setShowNewTab(true)} />

            <div className="terminal-area">
              {projectTabs.length === 0 ? (
                <div className="center-hint">
                  <p>No agents in <b>{activeProject.name}</b> yet.</p>
                  <button className="btn primary" onClick={() => setShowNewTab(true)}>+ New agent tab</button>
                </div>
              ) : (
                // Mount every tab's terminal; hide all but the active one so
                // background agents keep running and scrollback is preserved.
                projectTabs.map((t) => (
                  <TerminalView key={t.id} tabId={t.id} active={t.id === activeTabId} />
                ))
              )}

              {canResume && activeTab && (
                <div className="resume-overlay">
                  <div className="resume-card">
                    <div className="resume-title">Agent not running</div>
                    <div className="resume-sub">
                      {activeTab.status === 'exited'
                        ? 'This agent finished. '
                        : activeTab.status === 'error'
                          ? 'This agent stopped with an error. '
                          : 'This tab was restored from a previous session. '}
                      Resume to re-open its conversation (with full memory) in the same branch.
                    </div>
                    <button className="btn primary" onClick={() => void resumeTab(activeTab.id)}>
                      ▶ Resume agent
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
      {showNewTab && activeProject && (
        <NewTabDialog projectId={activeProject.id} onClose={() => setShowNewTab(false)} />
      )}

      {error && (
        <div className="toast error" onClick={() => setError(null)}>
          {error} <span className="toast-dismiss">(click to dismiss)</span>
        </div>
      )}
    </div>
  )
}
