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
  reconcile
} from '../lib/cloudSync'
import { accountOf, currentAccount, onAuthChange, type Account } from '../lib/supabase'
import { useChatStore } from './useChatStore'

/** A general chat covers the project view: the active agent tab is not what you're looking at. */
const chatOnScreen = (): boolean => useChatStore.getState().activeChatId !== null

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
  /** Signed-in account whose projects are shown; null = signed out (this computer's). */
  account: Account | null
  /**
   * Show this account's projects (null = signed out, i.e. the ones saved on
   * this computer). Switching stops the previous set's agents.
   */
  switchUser: (account: Account | null) => Promise<void>
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
  account: null,

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
      // General chats listen for reply progress; their list loads with the account below.
      useChatStore.getState().init()
      // Load the signed-in account's projects (or this computer's when signed
      // out), then follow sign-in/sign-out. SIGNED_OUT is the only event that
      // means "signed out": other events can carry no session while offline.
      await get().switchUser(await currentAccount())
      onAuthChange((session, event) => {
        if (event === 'SIGNED_OUT') void get().switchUser(null)
        else if (session) void get().switchUser(accountOf(session))
      })
      // Detect installed agent CLIs in the background (feeds the agent/model dropdowns).
      void window.fleet.listAgents().then((agents) => set({ agents })).catch(() => {})
      // Subscribe once to live backend events that mutate tab state.
      window.fleet.onTabStatus((tabId, status) => get().setTabStatus(tabId, status))
      window.fleet.onTabActivity?.((a) => get().onActivity(a))
      // Coming back to the window counts as seeing the current tab (unless a chat covers it).
      window.addEventListener('focus', () => {
        const id = get().activeTabId
        if (id && !chatOnScreen()) get().clearAttention(id)
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
    // A project is coming on screen, so any open chat steps aside.
    useChatStore.getState().select(null)
    const s = get()
    // Back to the project you were already in (e.g. from a chat): stay on its
    // tab. A different project opens on its first tab.
    const stay = s.activeProjectId === projectId && s.tabs.some((t) => t.id === s.activeTabId && t.projectId === projectId)
    const tabId = stay ? s.activeTabId : s.tabs.find((t) => t.projectId === projectId)?.id ?? null
    set({ activeProjectId: projectId, activeTabId: tabId })
    if (tabId) get().clearAttention(tabId)
  },

  selectTab: (tabId) => {
    useChatStore.getState().select(null)
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
    const viewing = s.activeTabId === tabId && document.hasFocus() && !chatOnScreen()
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
      useChatStore.getState().select(null) // show the new project, even if a chat was open
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
        status === 'error' && !(s.activeTabId === tabId && document.hasFocus() && !chatOnScreen())
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

  // Sync the shown account with the cloud (see doRestore). Startup and the auth
  // listener can both call this at once; share one run.
  restoreFromCloud: () => {
    restoreInFlight ??= doRestore().finally(() => { restoreInFlight = null })
    return restoreInFlight
  },

  // Serialized: sign-in events can arrive back to back.
  switchUser: (account) => {
    const run = switchChain.then(() => doSwitchUser(account))
    switchChain = run.catch(() => {})
    return run
  }
}))

let restoreInFlight: Promise<void> | null = null
let switchChain: Promise<void> = Promise.resolve()
/** Id of the account whose projects are shown (null = signed out); undefined until the first switch. */
let shownUser: string | null | undefined

async function doSwitchUser(account: Account | null): Promise<void> {
  const set = useStore.setState
  const userId = account?.id ?? null
  if (userId === shownUser) {
    if (account) {
      set({ account })
      void useStore.getState().restoreFromCloud() // e.g. token refresh: pick up other devices' changes
    }
    return
  }
  const previous = shownUser
  const { changed } = await window.fleet.setStoreUser(userId)
  shownUser = userId
  const [projects, tabs] = await Promise.all([window.fleet.listProjects(), window.fleet.listTabs()])
  set((s) => ({
    account,
    projects,
    tabs,
    activeProjectId: projects.some((p) => p.id === s.activeProjectId) ? s.activeProjectId : projects[0]?.id ?? null,
    activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : null,
    // The previous set's agents were stopped by the backend.
    ...(changed ? { liveTabIds: new Set<string>(), busy: {}, attention: {} } : {})
  }))
  // General chats belong to the account too.
  await useChatStore.getState().reload()
  if (!account) return
  const synced = useStore.getState().restoreFromCloud()
  // Just signed in from the signed-out view: offer to bring this computer's
  // projects and chats along (after syncing, so projects already in the
  // account aren't offered).
  if (previous === null) void synced.then(() => offerGuestData(account))
}

/** On sign-in: "Add the projects (and chats) saved on this computer to your account?" */
async function offerGuestData(account: Account): Promise<void> {
  if (shownUser !== account.id) return
  const guest = await window.fleet.guestData()
  const chats = (await window.fleet.guestChats?.().catch(() => [])) ?? []
  const s = useStore.getState()
  const ids = new Set(s.projects.map((p) => p.id))
  const paths = new Set(s.projects.map((p) => p.localPath))
  const candidates = guest.projects.filter((p) => !ids.has(p.id) && !paths.has(p.localPath))
  if (candidates.length === 0 && chats.length === 0) return

  const n = candidates.length
  const c = chats.length
  const one = n + c === 1
  const what = [
    n ? (n === 1 ? 'the project' : `the ${n} projects`) : '',
    c ? (c === 1 ? 'the chat' : `the ${c} chats`) : ''
  ].filter(Boolean).join(' and ')
  const list = [
    ...candidates.slice(0, 6).map((p) => `   • ${p.name}`),
    ...(n > 6 ? [`   … and ${n - 6} more`] : []),
    ...(c ? [`   • ${c} chat${c === 1 ? '' : 's'}`] : [])
  ].join('\n')
  const kept = c
    ? "shown while you're signed in; projects also sync to your other devices"
    : 'synced, shown while signed in'
  const ok = confirm(
    `Add ${what} saved on this computer to ${account.email ?? 'your account'}?\n\n${list}\n\n` +
      `OK: move ${one ? 'it' : 'them'} into your account (${kept}).\n` +
      `Cancel: keep ${one ? 'it' : 'them'} on this computer only (shown while signed out).`
  )
  if (!ok || shownUser !== account.id) return

  if (c) {
    await window.fleet.adoptGuestChats()
    await useChatStore.getState().reload()
  }
  if (!n) return
  const moved = await window.fleet.adoptGuestProjects(candidates.map((p) => p.id))
  useStore.setState((st) => ({
    projects: [...st.projects, ...moved.projects],
    tabs: [...st.tabs, ...moved.tabs],
    activeProjectId: st.activeProjectId ?? moved.projects[0]?.id ?? null
  }))
  for (const p of moved.projects) await pushProject(p)
  for (const t of moved.tabs) await pushTab(t)
}

// Sync the shown account with the cloud: add what's new there, drop what was
// deleted on another device, upload what was never uploaded. New entries are
// persisted to the backend store first (so tab:create can find them) and come
// in idle (no live process here). Tabs with a live agent here are kept, along
// with their project.
async function doRestore(): Promise<void> {
  const get = useStore.getState
  const set = useStore.setState
  const forUser = shownUser
  if (!forUser) return
  const before = get()
  const changes = await reconcile({ projects: before.projects, tabs: before.tabs })
  // Signed out or switched account meanwhile: this isn't for the current view.
  if (!changes || shownUser !== forUser) return

  const live = get().liveTabIds
  const liveProjects = new Set(get().tabs.filter((t) => live.has(t.id)).map((t) => t.projectId))
  const removeProjectIds = changes.removeProjectIds.filter((id) => !liveProjects.has(id))
  const removeTabIds = changes.removeTabIds.filter((id) => !live.has(id))
  const addProjects = changes.addProjects
  const addTabs = changes.addTabs.map((t) => ({ ...t, status: 'idle' as TabStatus }))
  if (!removeProjectIds.length && !removeTabIds.length && !addProjects.length && !addTabs.length) return

  if (removeProjectIds.length || removeTabIds.length) await window.fleet.removeEntries(removeProjectIds, removeTabIds)
  if (addProjects.length || addTabs.length) await window.fleet.importData(addProjects, addTabs)
  if (shownUser !== forUser) return

  const goneP = new Set(removeProjectIds)
  const goneT = new Set(removeTabIds)
  set((st) => {
    const projects = [...st.projects.filter((p) => !goneP.has(p.id)), ...addProjects]
    const tabs = [...st.tabs.filter((t) => !goneP.has(t.projectId) && !goneT.has(t.id)), ...addTabs]
    return {
      projects,
      tabs,
      activeProjectId: projects.some((p) => p.id === st.activeProjectId) ? st.activeProjectId : projects[0]?.id ?? null,
      activeTabId: tabs.some((t) => t.id === st.activeTabId) ? st.activeTabId : null
    }
  })
}
