import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  IPC,
  type CreateProjectOptions,
  type CreateTabOptions,
  type Project,
  type Tab
} from '@shared/types'
import { store } from './store'
import { sessionManager } from './sessionManager'
import { createWorktree, removeWorktree, isGitRepo } from './worktree'

const execFileAsync = promisify(execFile)

/**
 * Registers every IPC handler (the "waiter" between the React UI and the
 * backend) and forwards live PTY events from the session manager to the
 * renderer so terminals update in real time.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const broadcast = (channel: string, ...args: unknown[]): void => {
    getWindow()?.webContents.send(channel, ...args)
  }

  // --- Forward live session events to the UI --------------------------------
  sessionManager.on('data', (tabId, chunk) => broadcast(IPC.tabData, tabId, chunk))
  sessionManager.on('status', (tabId, status) => {
    store.updateTab(tabId, { status })
    broadcast(IPC.tabStatus, tabId, status)
  })
  sessionManager.on('exit', (tabId, exitCode) => {
    store.updateTab(tabId, { exitCode })
    broadcast(IPC.tabExit, tabId, exitCode)
  })

  // --- Projects -------------------------------------------------------------
  ipcMain.handle(IPC.projectList, async (): Promise<Project[]> => store.listProjects())

  ipcMain.handle(
    IPC.projectCreate,
    async (_e, opts: CreateProjectOptions): Promise<Project> => {
      if (!(await isGitRepo(opts.localPath))) {
        throw new Error(
          `"${opts.localPath}" is not a git repository. Pick a folder that contains a git repo.`
        )
      }
      const project: Project = {
        id: randomUUID(),
        name: opts.name,
        localPath: opts.localPath,
        githubUrl: opts.githubUrl,
        createdAt: Date.now()
      }
      await store.addProject(project)
      return project
    }
  )

  ipcMain.handle(IPC.projectRemove, async (_e, projectId: string): Promise<void> => {
    // Close any running tabs for this project first.
    const tabs = await store.listTabs(projectId)
    for (const t of tabs) sessionManager.kill(t.id)
    await store.removeProject(projectId)
  })

  // --- Tabs -----------------------------------------------------------------
  ipcMain.handle(IPC.tabList, async (_e, projectId?: string): Promise<Tab[]> =>
    store.listTabs(projectId)
  )

  ipcMain.handle(IPC.tabCreate, async (_e, opts: CreateTabOptions): Promise<Tab> => {
    const projects = await store.listProjects()
    const project = projects.find((p) => p.id === opts.projectId)
    if (!project) throw new Error('Project not found')

    // Each agent gets its own isolated worktree + branch.
    const { branch, worktreePath } = await createWorktree(
      project.localPath,
      opts.title,
      process.env.FLEET_WORKTREE_ROOT || undefined
    )

    const tab: Tab = {
      id: randomUUID(),
      projectId: opts.projectId,
      title: opts.title,
      task: opts.task,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      branch,
      worktreePath,
      status: 'idle',
      createdAt: Date.now()
    }
    await store.addTab(tab)

    // Spawn the agent. Start at a sane default size; UI resizes immediately.
    await sessionManager.spawn({ tab, cols: 80, rows: 24 })
    return tab
  })

  ipcMain.handle(
    IPC.tabClose,
    async (_e, tabId: string, deleteBranch = false): Promise<void> => {
      const tabs = await store.listTabs()
      const tab = tabs.find((t) => t.id === tabId)
      sessionManager.kill(tabId)
      if (tab) {
        const projects = await store.listProjects()
        const project = projects.find((p) => p.id === tab.projectId)
        if (project) {
          await removeWorktree(project.localPath, tab.worktreePath, tab.branch, deleteBranch).catch(
            (err) => console.error('worktree cleanup failed:', err)
          )
        }
      }
      await store.removeTab(tabId)
    }
  )

  ipcMain.on(IPC.tabInput, (_e, tabId: string, data: string) => {
    sessionManager.write(tabId, data)
  })

  ipcMain.on(IPC.tabResize, (_e, tabId: string, cols: number, rows: number) => {
    sessionManager.resize(tabId, cols, rows)
  })

  // --- Dialogs --------------------------------------------------------------
  ipcMain.handle(IPC.dialogPickFolder, async (): Promise<string | null> => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select a project folder (must be a git repo)',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // --- Auth / system --------------------------------------------------------
  // Open the GitHub OAuth page in the user's real browser (desktop apps can't
  // do the redirect dance inside the app window).
  ipcMain.handle(IPC.openExternal, async (_e, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

  // Clone a GitHub repo locally — used to materialise a project's code on a
  // machine that doesn't have it yet (the repo URL comes back from Supabase;
  // the files come back from GitHub). Clones into <userData>/repos/<name>.
  ipcMain.handle(IPC.cloneRepo, async (_e, githubUrl: string, name: string): Promise<string> => {
    const reposDir = join(app.getPath('userData'), 'repos')
    await mkdir(reposDir, { recursive: true })
    const dest = join(reposDir, name)
    await execFileAsync('git', ['clone', githubUrl, dest], { windowsHide: true })
    return dest
  })
}
