import { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import { startTerminalRouting } from './lib/terminalRegistry'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { NewProjectDialog } from './components/NewProjectDialog'
import { NewTabDialog } from './components/NewTabDialog'
import { BrowserPanel } from './components/BrowserPanel'
import { ImageViewer } from './components/ImageViewer'
import { SplashScreen } from './components/SplashScreen'

const readPref = (k: string, d: string): string => {
  try { return localStorage.getItem(k) ?? d } catch { return d }
}
const writePref = (k: string, v: string): void => {
  try { localStorage.setItem(k, v) } catch { /* ignore */ }
}

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
  const [editProjectId, setEditProjectId] = useState<string | null>(null)
  const [editTabId, setEditTabId] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(() => readPref('fleet.browser.open', '0') === '1')
  const [browserWidth, setBrowserWidth] = useState(() => Number(readPref('fleet.browser.width', '520')) || 520)
  const [dragging, setDragging] = useState(false)

  const toggleBrowser = (): void => {
    setBrowserOpen((o) => { writePref('fleet.browser.open', o ? '0' : '1'); return !o })
  }

  // Drag the splitter to resize the browser panel.
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    setDragging(true)
    const onMove = (ev: PointerEvent): void => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth - 560)
      setBrowserWidth(w)
    }
    const onUp = (ev: PointerEvent): void => {
      setDragging(false)
      writePref('fleet.browser.width', String(Math.round(window.innerWidth - ev.clientX)))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

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
    <div className={`app ${dragging ? 'dragging' : ''}`}>
      <ProjectSidebar onNewProject={() => setShowNewProject(true)} onEditProject={setEditProjectId} />

      <main className="workspace">
        {loading ? (
          null
        ) : !activeProject ? (
          <div className="center-hint">
            <h1>Welcome to Agent Fleet</h1>
            <p>Create a project to start launching agents.</p>
            <button className="btn primary" onClick={() => setShowNewProject(true)}>+ New project</button>
          </div>
        ) : (
          <>
            <TabBar
              projectId={activeProject.id}
              onNewTab={() => setShowNewTab(true)}
              onEditTab={setEditTabId}
              browserOpen={browserOpen}
              onToggleBrowser={toggleBrowser}
            />

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

      {browserOpen && (
        <>
          <div className="splitter" onPointerDown={startDrag} />
          <div className="browser-slot" style={{ width: browserWidth }}>
            <BrowserPanel onClose={toggleBrowser} />
          </div>
        </>
      )}

      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
      {showNewTab && activeProject && (
        <NewTabDialog projectId={activeProject.id} onClose={() => setShowNewTab(false)} />
      )}

      {editProjectId && (
        <NewProjectDialog
          project={projects.find((p) => p.id === editProjectId)}
          onClose={() => setEditProjectId(null)}
        />
      )}
      {editTabId && tabs.some((t) => t.id === editTabId) && (
        <NewTabDialog
          projectId={tabs.find((t) => t.id === editTabId)!.projectId}
          tab={tabs.find((t) => t.id === editTabId)}
          onClose={() => setEditTabId(null)}
        />
      )}

      <ImageViewer />
      <SplashScreen done={!loading} />

      {error && (
        <div className="toast error" onClick={() => setError(null)}>
          {error} <span className="toast-dismiss">(click to dismiss)</span>
        </div>
      )}
    </div>
  )
}
