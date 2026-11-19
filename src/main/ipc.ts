import { ipcMain, dialog, shell, app, BrowserWindow, webContents, clipboard } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import {
  IPC,
  type CreateProjectOptions,
  type CreateTabOptions,
  type UpdateProjectOptions,
  type UpdateTabOptions,
  type AgentInfo,
  type AppPrefs,
  type AgentKind,
  type AgentStatus,
  type FleetMessage,
  type Project,
  type Tab
} from '@shared/types'
import { store } from './store'
import { sessionManager } from './sessionManager'
import { createWorktree, removeWorktree, isGitRepo } from './worktree'
import { detectAgents, agentOf, agentStatus, agentPath, agentLogout, AGENT_AUTH } from './agents'
import { homedir } from 'node:os'
import { getPrefs, setPrefs } from './prefs'
import { teamContext, projectMessages, projectSessionNames, readBoard, writeBoard } from './team'

const execFileAsync = promisify(execFile)

/**
 * Registers every IPC handler (the "waiter" between the React UI and the
 * backend) and forwards live PTY events from the session manager to the
 * renderer so terminals update in real time.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const broadcast = (channel: string, ...args: unknown[]): void => {
    // The window can be gone (app quitting) while PTYs are still exiting;
    // sending to a destroyed webContents throws in the main process.
    const w = getWindow()
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
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
      // Any existing folder is allowed — it can be a single repo OR a container
      // of several repos. Worktree isolation only kicks in if it's a git repo.
      if (!existsSync(opts.localPath)) {
        throw new Error(`Folder "${opts.localPath}" does not exist.`)
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

  ipcMain.handle(
    IPC.projectUpdate,
    async (_e, projectId: string, opts: UpdateProjectOptions): Promise<{ project: Project; tabs: Tab[] }> => {
      if (!opts.name.trim()) throw new Error('Name is required.')
      if (!existsSync(opts.localPath)) throw new Error(`Folder "${opts.localPath}" does not exist.`)
      const res = await store.updateProject(projectId, {
        name: opts.name.trim(),
        localPath: opts.localPath.trim(),
        githubUrl: opts.githubUrl?.trim() || undefined
      })
      if (!res) throw new Error('Project not found')
      return res
    }
  )

  // --- Tabs -----------------------------------------------------------------
  ipcMain.handle(IPC.tabList, async (_e, projectId?: string): Promise<Tab[]> =>
    store.listTabs(projectId)
  )

  ipcMain.handle(IPC.tabCreate, async (_e, opts: CreateTabOptions): Promise<Tab> => {
    const projects = await store.listProjects()
    const project = projects.find((p) => p.id === opts.projectId)
    if (!project) throw new Error('Project not found')

    // Worktree isolation is opt-in: only when the user asked for it AND the
    // project is a git repo. Otherwise the agent runs directly in the project
    // folder — and closing the tab must NOT delete that folder.
    let branch = ''
    let worktreePath = project.localPath
    if (opts.isolate && (await isGitRepo(project.localPath))) {
      const wt = await createWorktree(
        project.localPath,
        opts.title,
        process.env.FLEET_WORKTREE_ROOT || undefined
      )
      branch = wt.branch
      worktreePath = wt.worktreePath
    }

    const tab: Tab = {
      id: randomUUID(),
      projectId: opts.projectId,
      title: opts.title,
      agent: opts.agent ?? 'claude',
      task: opts.task,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      branch,
      worktreePath,
      // Stable id used for --session-id now and --resume later.
      sessionId: randomUUID(),
      status: 'idle',
      createdAt: Date.now()
    }
    await store.addTab(tab)

    // Spawn the agent. Start at a sane default size; UI resizes immediately.
    await sessionManager.spawn({ tab, cols: 80, rows: 24, team: agentOf(tab) === 'claude' ? await teamContext(tab).catch(() => null) : null })
    return tab
  })

  // Re-attach a tab's saved Claude conversation (resume after it stopped).
  ipcMain.handle(IPC.tabResume, async (_e, tabId: string): Promise<Tab> => {
    const tabs = await store.listTabs()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('Tab not found')
    if (sessionManager.isRunning(tabId)) return tab // already live
    if (!existsSync(tab.worktreePath)) {
      throw new Error(
        `This tab's worktree folder isn't on this machine (${tab.worktreePath}). ` +
          `Its code/conversation live where it was created.`
      )
    }
    await sessionManager.spawn({ tab, cols: 80, rows: 24, resume: true, team: agentOf(tab) === 'claude' ? await teamContext(tab).catch(() => null) : null })
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
        // Only clean up a worktree we created. If the tab ran directly in the
        // project folder (non-git project), leave the user's folder untouched.
        if (project && tab.worktreePath !== project.localPath) {
          await removeWorktree(project.localPath, tab.worktreePath, tab.branch, deleteBranch).catch(
            (err) => console.error('worktree cleanup failed:', err)
          )
        }
      }
      await store.removeTab(tabId)
    }
  )

  // Edit an agent tab. A running agent keeps its current settings; new
  // model/effort/mode take effect the next time it is launched or resumed.
  ipcMain.handle(IPC.tabUpdate, async (_e, tabId: string, opts: UpdateTabOptions): Promise<Tab> => {
    if (!opts.title.trim()) throw new Error('Name is required.')
    const before = (await store.listTabs()).find((t) => t.id === tabId)
    const agentChanged = opts.agent != null && before != null && agentOf(before) !== opts.agent
    await store.updateTab(tabId, {
      ...(opts.agent ? { agent: opts.agent } : {}),
      // A different agent can't continue the old conversation: give it a fresh session.
      ...(agentChanged ? { sessionId: randomUUID() } : {}),
      title: opts.title.trim(),
      task: opts.task.trim(),
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode
    })
    const tab = (await store.listTabs()).find((t) => t.id === tabId)
    if (!tab) throw new Error('Tab not found')
    return tab
  })

  ipcMain.handle(IPC.tabKill, async (_e, id: string): Promise<void> => sessionManager.kill(id))
  ipcMain.handle(IPC.agentsList, async (_e, refresh?: boolean): Promise<AgentInfo[]> => detectAgents(refresh))

  ipcMain.handle(IPC.prefsGet, (): AppPrefs => getPrefs())
  ipcMain.handle(IPC.prefsSet, (_e, patch: Partial<AppPrefs>): Promise<AppPrefs> => setPrefs(patch))

  ipcMain.handle(IPC.agentStatus, async (_e, id: AgentKind): Promise<AgentStatus> => agentStatus(id))

  // Sign in: run the CLI's own login flow in a utility terminal the UI shows
  // in a dialog (it may open the browser and/or ask for input). Returns the
  // terminal's session id. The CLI stores the credentials itself.
  ipcMain.handle(IPC.agentLogin, async (_e, id: AgentKind): Promise<string> => {
    const cmd = await agentPath(id)
    if (!cmd) throw new Error('Agent is not installed.')
    const sid = `auth:${id}`
    sessionManager.kill(sid)
    sessionManager.spawnCommand(sid, cmd.file, [...cmd.prefix, ...AGENT_AUTH[id].login], homedir(), 90, 20)
    return sid
  })

  ipcMain.handle(IPC.agentLogout, async (_e, id: AgentKind): Promise<void> => agentLogout(id))

  // Stop a tab's agent and launch it again with its saved settings. `fresh`
  // starts a new conversation (e.g. after switching agent CLI); otherwise the
  // conversation is resumed so the agent keeps its memory.
  ipcMain.handle(IPC.tabRestart, async (_e, tabId: string, fresh = false): Promise<Tab> => {
    const tab = (await store.listTabs()).find((t) => t.id === tabId)
    if (!tab) throw new Error('Tab not found')
    sessionManager.kill(tabId)
    const team = agentOf(tab) === 'claude' ? await teamContext(tab).catch(() => null) : null
    await sessionManager.spawn({ tab, cols: 80, rows: 24, resume: !fresh, team })
    return tab
  })

  // --- Team: board, messages, names -----------------------------------------
  ipcMain.handle(IPC.boardRead, async (_e, projectId: string): Promise<string> => readBoard(projectId))
  ipcMain.handle(IPC.boardWrite, async (_e, projectId: string, text: string): Promise<void> =>
    writeBoard(projectId, text)
  )
  ipcMain.handle(IPC.messagesList, async (_e, projectId: string): Promise<FleetMessage[]> =>
    projectMessages(projectId)
  )
  ipcMain.handle(IPC.sessionNames, async (_e, projectId: string): Promise<Record<string, string>> =>
    projectSessionNames(projectId)
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
      title: 'Select a project folder',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // Persist cloud-restored projects/tabs into the local store so the backend
  // and the UI agree (prevents "Project not found" on tab:create).
  ipcMain.handle(
    IPC.storeImport,
    async (_e, payload: { projects?: Project[]; tabs?: Tab[] }): Promise<void> => {
      await store.importProjects(payload.projects ?? [])
      await store.importTabs(payload.tabs ?? [])
    }
  )

  // Show the signed-in account's projects (null = signed out). Agents of the
  // previous set's tabs are stopped: they belong to someone else's view.
  ipcMain.handle(IPC.storeSetUser, async (_e, userId: string | null): Promise<{ changed: boolean }> => {
    const { changed, previousTabIds } = await store.setUser(userId || null)
    for (const id of previousTabIds) sessionManager.kill(id)
    return { changed }
  })
  ipcMain.handle(IPC.storeGuestData, async (): Promise<{ projects: Project[]; tabs: Tab[] }> => store.guestData())
  ipcMain.handle(IPC.storeAdoptGuest, async (_e, projectIds: string[]): Promise<{ projects: Project[]; tabs: Tab[] }> =>
    store.adoptGuestProjects(projectIds)
  )
  ipcMain.handle(IPC.storeRemove, async (_e, projectIds: string[], tabIds: string[]): Promise<void> =>
    store.removeEntries(projectIds, tabIds)
  )

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

  // --- Side browser ---------------------------------------------------------
  // Screenshot the side-browser <webview>. Done here (not in the renderer) so
  // the UI never needs direct access to another page's webContents.
  ipcMain.handle(IPC.browserCapture, async (_e, id: number): Promise<string> => {
    const wc = webContents.fromId(id)
    if (!wc || wc.getType() !== 'webview') throw new Error('Browser page not found.')
    const img = await wc.capturePage()
    return img.toDataURL()
  })

  // Save an annotated screenshot to <project>/.fleet/shots/ and return its
  // absolute path, so an agent working in the project can read it.
  ipcMain.handle(IPC.shotSave, async (_e, projectId: string, dataUrl: string): Promise<string> => {
    const project = (await store.listProjects()).find((p) => p.id === projectId)
    if (!project) throw new Error('Project not found.')
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
    if (!m) throw new Error('Expected a PNG image.')
    const fleetDir = join(project.localPath, '.fleet')
    const dir = join(fleetDir, 'shots')
    await mkdir(dir, { recursive: true })
    // Keep screenshots out of git without touching the project's own .gitignore.
    const ignore = join(fleetDir, '.gitignore')
    if (!existsSync(ignore)) await writeFile(ignore, '*\n')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `shot-${stamp}.png`)
    await writeFile(file, Buffer.from(m[1], 'base64'))
    return file
  })

  // Read an image straight from the OS clipboard. The page's paste event can
  // miss bitmap-only clipboards (e.g. Windows clipboard history, Win+V).
  ipcMain.handle(IPC.clipboardImage, (): string | null => {
    const img = clipboard.readImage()
    return img.isEmpty() ? null : img.toDataURL()
  })
  ipcMain.handle(IPC.clipboardFormats, (): string[] => clipboard.availableFormats())
  // Synchronous so a Ctrl+V keydown can decide on the spot whether to take over.
  ipcMain.on(IPC.clipboardHasImage, (e) => {
    e.returnValue = !clipboard.readImage().isEmpty()
  })

  // --- Image viewer ---------------------------------------------------------
  // Claude Code saves pasted images (shown as "[Image #N]" in its prompt) to
  // <tmp>/claude/<project-hash>/<sessionId>/images/<N>.png as soon as they're
  // pasted. Each tab has a stable sessionId, so we can find the file.
  ipcMain.handle(IPC.imageResolve, async (_e, tabId: string, n: number): Promise<string | null> => {
    const tab = (await store.listTabs()).find((t) => t.id === tabId)
    if (!tab || !Number.isInteger(n)) return null
    const base = join(tmpdir(), 'claude')
    let dirs: string[] = []
    try { dirs = await readdir(base) } catch { return null }
    for (const d of dirs) {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
        const file = join(base, d, tab.sessionId, 'images', `${n}.${ext}`)
        if (existsSync(file)) return file
      }
    }
    return null
  })

  ipcMain.handle(IPC.imageRead, async (_e, path: string): Promise<string> => {
    const mime = IMAGE_MIME[extname(path).toLowerCase()]
    if (!mime) throw new Error('Not an image file.')
    const buf = await readFile(path)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle(IPC.imageReveal, async (_e, path: string): Promise<void> => {
    if (IMAGE_MIME[extname(path).toLowerCase()]) shell.showItemInFolder(path)
  })
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
