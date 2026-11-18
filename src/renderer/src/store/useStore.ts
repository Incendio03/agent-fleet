import { create } from 'zustand'
import { getNotifyPrefs, showNotification } from '../lib/notify'
import type {
  TabActivity,
  AgentInfo,
  CreateProjectOptions,
  CreateTabOptions,
  UpdateProjectOptions,
  UpdateTabOptions,
  Project,
  Tab,
  TabStatus
} from '@shared/types'
import {
  pushProject,
  pushTab,
  deleteProjectCloud,
  deleteTabCloud,
  pullAll
} from '../lib/cloudSync'

/**
 * Central UI state. Components read from here and call these actions; the
 * actions delegate to the backend via window.fleet (the preload bridge).
 */
interface FleetState {
  projects: Project[]
  tabs: Tab[]
  activeProjectId: string | null
  activeTabId: string | null
  /**
   * Ids of tabs that have a LIVE agent process in this app run. This is the
   * source of truth for "is this tab running?" — NOT the persisted status,
   * which can be stale after a restart (and would otherwise leave a blank
   * terminal with no Resume overlay).
   */
  liveTabIds: Set<string>
  loading: boolean
  error: string | null
  /** Tabs whose agent is mid-turn (between prompt and finish), from its hooks. */
  busy: Record<string, boolean>
  /** Tabs that want you: finished while you weren't looking, need input, or errored. */
  attention: Record<string, { kind: 'done' | 'input' | 'error'; message?: string; ts: number }>
  onActivity: (a: TabActivity) => void
  clearAttention: (tabId: string) => void
  /** Agent CLIs detected on this machine (with their models/efforts). */
  agents: AgentInfo[]
  /** Image currently shown in the full-window viewer, if any. */
  viewer: { src: string; path: string } | null

  // selectors as plain derived helpers are done in components; actions below
  init: () => Promise<void>
  selectProject: (projectId: string) => void
  selectTab: (tabId: string) => void
  createProject: (opts: CreateProjectOptions) => Promise<void>
  removeProject: (projectId: string) => Promise<void>
  updateProject: (projectId: string, opts: UpdateProjectOptions) => Promise<void>
  updateTab: (tabId: string, opts: UpdateTabOptions) => Promise<void>
  restartTab: (tabId: string, fresh?: boolean) => Promise<void>
  setAgents: (agents: AgentInfo[]) => void
  createTab: (opts: CreateTabOptions) => Promise<void>
  resumeTab: (tabId: string) => Promise<void>
  closeTab: (tabId: string, deleteBranch?: boolean) => Promise<void>
  setTabStatus: (tabId: string, status: TabStatus) => void
  setError: (msg: string | null) => void
  restoreFromCloud: () => Promise<void>
  openImage: (path: string) => Promise<void>
  closeImage: () => void
}

export const useStore = create<FleetState>((set, get) => ({
  projects: [],
  tabs: [],
  activeProjectId: null,
  activeTabId: null,
  liveTabIds: new Set<string>(),
  loading: true,
  error: null,
  viewer: null,
  busy: {},
  attention: {},
  agents: [],

  openImage: async (path) => {
    try {
      set({ viewer: { src: await window.fleet.readImage(path), path } })
    } catch (err) {
      set({ error: `Could not open image: ${(err as Error).message}` })
    }
  },
  closeImage: () => set({ viewer: null }),

  init: async () => {
    set({ loading: true })
    try {
      const [projects, tabs] = await Promise.all([
        window.fleet.listProjects(),
        window.fleet.listTabs()
      ])
      set({ projects, tabs })
      // Detect installed agent CLIs in the background (feeds the agent/model dropdowns).
      void window.fleet.listAgents().then((agents) => set({ agents })).catch(() => {})
      // Subscribe once to live backend events that mutate tab state.
      window.fleet.onTabStatus((tabId, status) => get().setTabStatus(tabId, status))
      window.fleet.onTabActivity?.((a) => get().onActivity(a))
      // Coming back to the window counts as seeing the current tab.
      window.addEventListener('focus', () => {
        const id = get().activeTabId
        if (id) get().clearAttention(id)
      })
      window.fleet.onTabExit((tabId, exitCode) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, exitCode } : t))
        }))
      )
      // Stay on the loading screen until cloud projects are in too (no-op when
      // signed out), so the UI doesn't flash "Welcome" and then pop projects in.
      // Capped so a slow/offline network never blocks startup.
      await Promise.race([
        get().restoreFromCloud().catch(() => {}),
        new Promise((r) => setTimeout(r, 8000))
      ])
      set((s) => ({ loading: false, activeProjectId: s.activeProjectId ?? s.projects[0]?.id ?? null }))
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  selectProject: (projectId) => {
    const firstTab = get().tabs.find((t) => t.projectId === projectId)
    set({ activeProjectId: projectId, activeTabId: firstTab?.id ?? null })
    if (firstTab) get().clearAttention(firstTab.id)
  },

  selectTab: (tabId) => {
    set({ activeTabId: tabId })
    get().clearAttention(tabId) // you're looking at it now
  },

  clearAttention: (tabId) =>
    set((s) => {
      if (!s.attention[tabId]) return {}
      const attention = { ...s.attention }
      delete attention[tabId]
      return { attention }
    }),

  onActivity: ({ tabId, kind, message }) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (kind === 'working') {
      set({ busy: { ...s.busy, [tabId]: true } })
      s.clearAttention(tabId)
      return
    }
    // done: finished its turn. input: blocked on you (still mid-turn).
    // Claude also sends an idle "waiting for your input" reminder ~a minute
    // after finishing; that's already covered by "done", so skip it.
    if (kind === 'input' && !s.busy[tabId]) return
    if (kind === 'done') set({ busy: { ...get().busy, [tabId]: false } })
    const viewing = s.activeTabId === tabId && document.hasFocus()
    if (viewing) return // you saw it happen
    set({ attention: { ...get().attention, [tabId]: { kind, message, ts: Date.now() } } })
    const prefs = getNotifyPrefs()
    if (!prefs.enabled || (kind === 'done' ? !prefs.done : !prefs.input)) return
    const project = s.projects.find((p) => p.id === tab.projectId)
    const title = kind === 'done' ? `${tab.title} finished` : `${tab.title} needs you`
    const body = (kind === 'input' && message) || (kind === 'done' ? 'Ready for your next message.' : 'Waiting for your input.')
    showNotification(project ? `${title} · ${project.name}` : title, body, () => {
      get().selectProject(tab.projectId)
      get().selectTab(tab.id)
    })
  },

  createProject: async (opts) => {
    try {
      const project = await window.fleet.createProject(opts)
      set((s) => ({
        projects: [...s.projects, project],
        activeProjectId: project.id,
        activeTabId: null
      }))
      void pushProject(project) // mirror to cloud (no-op if not signed in)
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    }
  },

  updateProject: async (projectId, opts) => {
    const { project, tabs } = await window.fleet.updateProject(projectId, opts)
    const byId = new Map(tabs.map((t) => [t.id, t]))
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? project : p)),
      // Keep live status from the UI; take the rest (e.g. moved path) from backend.
      tabs: s.tabs.map((t) => (byId.has(t.id) ? { ...byId.get(t.id)!, status: t.status } : t))
    }))
    void pushProject(project)
    for (const t of tabs) void pushTab(t)
  },

  updateTab: async (tabId, opts) => {
    const tab = await window.fleet.updateTab(tabId, opts)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...tab, status: t.status } : t)) }))
    void pushTab(tab)
  },

  setAgents: (agents) => set({ agents }),

  restartTab: async (tabId, fresh) => {
    try {
      await window.fleet.restartTab(tabId, fresh)
      set((s) => {
        const live = new Set(s.liveTabIds)
        live.add(tabId)
        return { liveTabIds: live }
      })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  removeProject: async (projectId) => {
    await window.fleet.removeProject(projectId)
    void deleteProjectCloud(projectId)
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== projectId)
      return {
        projects,
        tabs: s.tabs.filter((t) => t.projectId !== projectId),
        activeProjectId: s.activeProjectId === projectId ? projects[0]?.id ?? null : s.activeProjectId
      }
    })
  },

  createTab: async (opts) => {
    try {
      const tab = await window.fleet.createTab(opts)
      set((s) => {
        const live = new Set(s.liveTabIds)
        live.add(tab.id) // it's spawning now — mark live so no Resume overlay shows
        return { tabs: [...s.tabs, tab], activeTabId: tab.id, liveTabIds: live }
      })
      void pushTab(tab) // mirror to cloud (no-op if not signed in)
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    }
  },

  resumeTab: async (tabId) => {
    try {
      await window.fleet.resumeTab(tabId)
      set((s) => {
        const live = new Set(s.liveTabIds)
        live.add(tabId) // re-spawned — it's live again
        return { liveTabIds: live }
      })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  closeTab: async (tabId, deleteBranch) => {
    await window.fleet.closeTab(tabId, deleteBranch)
    void deleteTabCloud(tabId)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const sameProject = tabs.filter((t) => t.projectId === s.activeProjectId)
      const live = new Set(s.liveTabIds)
      live.delete(tabId)
      return {
        tabs,
        liveTabIds: live,
        activeTabId: s.activeTabId === tabId ? sameProject[0]?.id ?? null : s.activeTabId
      }
    })
  },

  setTabStatus: (tabId, status) =>
    set((s) => {
      const live = new Set(s.liveTabIds)
      // A live agent is one that is starting or running; anything else
      // (exited/error/idle) means no process, so it becomes resumable.
      if (status === 'running' || status === 'starting') live.add(tabId)
      else live.delete(tabId)
      const stopped = status === 'exited' || status === 'error'
      // An agent that crashed while you weren't looking wants attention too.
      const attention =
        status === 'error' && !(s.activeTabId === tabId && document.hasFocus())
          ? { ...s.attention, [tabId]: { kind: 'error' as const, ts: Date.now() } }
          : s.attention
      return {
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
        liveTabIds: live,
        busy: stopped ? { ...s.busy, [tabId]: false } : s.busy,
        attention
      }
    }),

  setError: (msg) => set({ error: msg }),

  // Pull the signed-in user's projects/tabs from Supabase, PERSIST the new ones
  // into the backend store (so tab:create can find them), then merge into view.
  // Dedupe projects by id AND localPath so the same folder isn't shown twice.
  // Restored tabs have no live process here, so force their status to 'idle'.
  // Startup and the auth listener can both call this at once; share one run.
  restoreFromCloud: () => {
    restoreInFlight ??= doRestore().finally(() => { restoreInFlight = null })
    return restoreInFlight
  }
}))

let restoreInFlight: Promise<void> | null = null

async function doRestore(): Promise<void> {
  const get = useStore.getState
  const set = useStore.setState
  {
    const snap = await pullAll()
    if (!snap) return
    const s = get()
    const existingIds = new Set(s.projects.map((p) => p.id))
    const existingPaths = new Set(s.projects.map((p) => p.localPath))
    const newProjects = snap.projects.filter(
      (p) => !existingIds.has(p.id) && !existingPaths.has(p.localPath)
    )
    // Only accept tabs whose project will actually exist locally.
    const validProjectIds = new Set([...existingIds, ...newProjects.map((p) => p.id)])
    const existingTabIds = new Set(s.tabs.map((t) => t.id))
    const newTabs = snap.tabs
      .filter((t) => !existingTabIds.has(t.id) && validProjectIds.has(t.projectId))
      .map((t) => ({ ...t, status: 'idle' as TabStatus }))

    if (newProjects.length || newTabs.length) {
      // Write to the backend store first — this is what fixes "Project not found".
      await window.fleet.importData(newProjects, newTabs)
      set((st) => ({
        projects: [...st.projects, ...newProjects],
        tabs: [...st.tabs, ...newTabs]
      }))
    }
  }
}
