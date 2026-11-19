import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type CreateProjectOptions,
  type AgentInfo,
  type AppPrefs,
  type AgentKind,
  type AgentStatus,
  type CreateTabOptions,
  type FleetMessage,
  type TabActivity,
  type UpdateProjectOptions,
  type UpdateTabOptions,
  type Project,
  type Tab,
  type TabStatus
} from '../shared/types'

/**
 * The preload bridge: the ONLY thing the sandboxed UI can see of the backend.
 *
 * The renderer can't touch Node or the OS directly (that would be a security
 * hole). Instead we expose a small, explicit `window.fleet` API here. Every
 * call is forwarded over IPC to a matching handler in the main process.
 */
const api = {
  // --- Projects ---
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projectList),
  createProject: (opts: CreateProjectOptions): Promise<Project> =>
    ipcRenderer.invoke(IPC.projectCreate, opts),
  removeProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.projectRemove, projectId),

  updateProject: (projectId: string, opts: UpdateProjectOptions): Promise<{ project: Project; tabs: Tab[] }> =>
    ipcRenderer.invoke(IPC.projectUpdate, projectId, opts),

  // --- Tabs ---
  updateTab: (tabId: string, opts: UpdateTabOptions): Promise<Tab> => ipcRenderer.invoke(IPC.tabUpdate, tabId, opts),
  listTabs: (projectId?: string): Promise<Tab[]> => ipcRenderer.invoke(IPC.tabList, projectId),
  createTab: (opts: CreateTabOptions): Promise<Tab> => ipcRenderer.invoke(IPC.tabCreate, opts),
  resumeTab: (tabId: string): Promise<Tab> => ipcRenderer.invoke(IPC.tabResume, tabId),
  closeTab: (tabId: string, deleteBranch?: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.tabClose, tabId, deleteBranch),

  // --- Terminal I/O (fire-and-forget) ---
  sendInput: (tabId: string, data: string): void => ipcRenderer.send(IPC.tabInput, tabId, data),
  resize: (tabId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.tabResize, tabId, cols, rows),

  // --- Dialogs ---
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickFolder),

  // --- Side browser ---
  captureBrowser: (webContentsId: number): Promise<string> =>
    ipcRenderer.invoke(IPC.browserCapture, webContentsId),
  readClipboardImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.clipboardImage),
  clipboardFormats: (): Promise<string[]> => ipcRenderer.invoke(IPC.clipboardFormats),
  /** Synchronous check, for deciding inside a Ctrl+V keydown. */
  clipboardHasImage: (): boolean => ipcRenderer.sendSync(IPC.clipboardHasImage) === true,
  saveShot: (projectId: string, dataUrl: string): Promise<string> =>
    ipcRenderer.invoke(IPC.shotSave, projectId, dataUrl),
  onBrowserOpenTab: (cb: (url: string) => void): (() => void) => {
    const h = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on(IPC.browserOpenTab, h)
    return () => ipcRenderer.removeListener(IPC.browserOpenTab, h)
  },
  onBrowserShortcut: (cb: (action: 'newTab' | 'closeTab') => void): (() => void) => {
    const h = (_e: unknown, action: 'newTab' | 'closeTab'): void => cb(action)
    ipcRenderer.on(IPC.browserShortcut, h)
    return () => ipcRenderer.removeListener(IPC.browserShortcut, h)
  },
  onBrowserZoom: (cb: (percent: number) => void): (() => void) => {
    const h = (_e: unknown, percent: number): void => cb(percent)
    ipcRenderer.on(IPC.browserZoom, h)
    return () => ipcRenderer.removeListener(IPC.browserZoom, h)
  },

  // --- Files ---
  /** Absolute path of a dropped/selected File (empty if it has none). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // --- Preferences ---
  getPrefs: (): Promise<AppPrefs> => ipcRenderer.invoke(IPC.prefsGet),
  setPrefs: (patch: Partial<AppPrefs>): Promise<AppPrefs> => ipcRenderer.invoke(IPC.prefsSet, patch),

  // --- Agents ---
  listAgents: (refresh?: boolean): Promise<AgentInfo[]> => ipcRenderer.invoke(IPC.agentsList, refresh),
  restartTab: (tabId: string, fresh?: boolean): Promise<Tab> => ipcRenderer.invoke(IPC.tabRestart, tabId, fresh),
  agentStatus: (id: AgentKind): Promise<AgentStatus> => ipcRenderer.invoke(IPC.agentStatus, id),
  agentLogin: (id: AgentKind): Promise<string> => ipcRenderer.invoke(IPC.agentLogin, id),
  agentLogout: (id: AgentKind): Promise<void> => ipcRenderer.invoke(IPC.agentLogout, id),
  killSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tabKill, id),

  // --- Team ---
  readBoard: (projectId: string): Promise<string> => ipcRenderer.invoke(IPC.boardRead, projectId),
  writeBoard: (projectId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.boardWrite, projectId, text),
  listMessages: (projectId: string): Promise<FleetMessage[]> => ipcRenderer.invoke(IPC.messagesList, projectId),
  sessionNames: (projectId: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IPC.sessionNames, projectId),

  // --- Image viewer ---
  resolveImage: (tabId: string, n: number): Promise<string | null> =>
    ipcRenderer.invoke(IPC.imageResolve, tabId, n),
  readImage: (path: string): Promise<string> => ipcRenderer.invoke(IPC.imageRead, path),
  revealImage: (path: string): Promise<void> => ipcRenderer.invoke(IPC.imageReveal, path),

  // --- Sync / system ---
  importData: (projects: Project[], tabs: Tab[]): Promise<void> =>
    ipcRenderer.invoke(IPC.storeImport, { projects, tabs }),
  setStoreUser: (userId: string | null): Promise<{ changed: boolean }> =>
    ipcRenderer.invoke(IPC.storeSetUser, userId),
  guestData: (): Promise<{ projects: Project[]; tabs: Tab[] }> => ipcRenderer.invoke(IPC.storeGuestData),
  adoptGuestProjects: (projectIds: string[]): Promise<{ projects: Project[]; tabs: Tab[] }> =>
    ipcRenderer.invoke(IPC.storeAdoptGuest, projectIds),
  removeEntries: (projectIds: string[], tabIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.storeRemove, projectIds, tabIds),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  cloneRepo: (githubUrl: string, name: string): Promise<string> =>
    ipcRenderer.invoke(IPC.cloneRepo, githubUrl, name),
  onAuthCallback: (cb: (url: string) => void): (() => void) => {
    const h = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on(IPC.authCallback, h)
    return () => ipcRenderer.removeListener(IPC.authCallback, h)
  },

  // --- Live events from the backend (returns an unsubscribe fn) ---
  onTabData: (cb: (tabId: string, chunk: string) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, chunk: string): void => cb(tabId, chunk)
    ipcRenderer.on(IPC.tabData, h)
    return () => ipcRenderer.removeListener(IPC.tabData, h)
  },
  onTabStatus: (cb: (tabId: string, status: TabStatus) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, status: TabStatus): void => cb(tabId, status)
    ipcRenderer.on(IPC.tabStatus, h)
    return () => ipcRenderer.removeListener(IPC.tabStatus, h)
  },
  onTabActivity: (cb: (activity: TabActivity) => void): (() => void) => {
    const h = (_e: unknown, a: TabActivity): void => cb(a)
    ipcRenderer.on(IPC.tabActivity, h)
    return () => ipcRenderer.removeListener(IPC.tabActivity, h)
  },
  focusWindow: (): void => ipcRenderer.send(IPC.windowFocus),
  onTabExit: (cb: (tabId: string, exitCode: number) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, exitCode: number): void => cb(tabId, exitCode)
    ipcRenderer.on(IPC.tabExit, h)
    return () => ipcRenderer.removeListener(IPC.tabExit, h)
  }
}

contextBridge.exposeInMainWorld('fleet', api)

export type FleetApi = typeof api
