import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CreateProjectOptions,
  type CreateTabOptions,
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

  // --- Tabs ---
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

  // --- Auth / system ---
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
  onTabExit: (cb: (tabId: string, exitCode: number) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, exitCode: number): void => cb(tabId, exitCode)
    ipcRenderer.on(IPC.tabExit, h)
    return () => ipcRenderer.removeListener(IPC.tabExit, h)
  }
}

contextBridge.exposeInMainWorld('fleet', api)

export type FleetApi = typeof api
