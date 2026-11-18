import { create } from 'zustand'
import type {
  CreateProjectOptions,
  CreateTabOptions,
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
  loading: boolean
  error: string | null

  // selectors as plain derived helpers are done in components; actions below
  init: () => Promise<void>
  selectProject: (projectId: string) => void
  selectTab: (tabId: string) => void
  createProject: (opts: CreateProjectOptions) => Promise<void>
  removeProject: (projectId: string) => Promise<void>
  createTab: (opts: CreateTabOptions) => Promise<void>
  closeTab: (tabId: string, deleteBranch?: boolean) => Promise<void>
  setTabStatus: (tabId: string, status: TabStatus) => void
  setError: (msg: string | null) => void
  restoreFromCloud: () => Promise<void>
}

export const useStore = create<FleetState>((set, get) => ({
  projects: [],
  tabs: [],
  activeProjectId: null,
  activeTabId: null,
  loading: true,
  error: null,

  init: async () => {
    set({ loading: true })
    try {
      const [projects, tabs] = await Promise.all([
        window.fleet.listProjects(),
        window.fleet.listTabs()
      ])
      set({
        projects,
        tabs,
        activeProjectId: projects[0]?.id ?? null,
        loading: false
      })
      // Subscribe once to live backend events that mutate tab state.
      window.fleet.onTabStatus((tabId, status) => get().setTabStatus(tabId, status))
      window.fleet.onTabExit((tabId, exitCode) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, exitCode } : t))
        }))
      )
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  selectProject: (projectId) => {
    const firstTab = get().tabs.find((t) => t.projectId === projectId)
    set({ activeProjectId: projectId, activeTabId: firstTab?.id ?? null })
  },

  selectTab: (tabId) => set({ activeTabId: tabId }),

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
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
      void pushTab(tab) // mirror to cloud (no-op if not signed in)
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    }
  },

  closeTab: async (tabId, deleteBranch) => {
    await window.fleet.closeTab(tabId, deleteBranch)
    void deleteTabCloud(tabId)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const sameProject = tabs.filter((t) => t.projectId === s.activeProjectId)
      return {
        tabs,
        activeTabId: s.activeTabId === tabId ? sameProject[0]?.id ?? null : s.activeTabId
      }
    })
  },

  setTabStatus: (tabId, status) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)) })),

  setError: (msg) => set({ error: msg }),

  // Pull the signed-in user's projects/tabs from Supabase and merge them into
  // the current view (dedupe by id). Projects whose local folder no longer
  // exists on this machine can be re-cloned from their GitHub URL.
  restoreFromCloud: async () => {
    const snap = await pullAll()
    if (!snap) return
    set((s) => {
      const projectIds = new Set(s.projects.map((p) => p.id))
      const tabIds = new Set(s.tabs.map((t) => t.id))
      return {
        projects: [...s.projects, ...snap.projects.filter((p) => !projectIds.has(p.id))],
        tabs: [...s.tabs, ...snap.tabs.filter((t) => !tabIds.has(t.id))]
      }
    })
  }
}))
