import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { Project, Tab } from '@shared/types'

/**
 * Local persistence for projects and tabs.
 *
 * This is the on-disk source of truth the app always reads/writes, so it works
 * fully offline. When Supabase is configured, the renderer mirrors this up to
 * the cloud (and pulls it back down on whatever device you sign in from).
 * Keeping a local JSON file means the app never blocks on the network.
 *
 * Each account has its own file, so people sharing a computer never see each
 * other's projects:
 *   data/store.json           signed out ("this computer")
 *   data/users/<userId>.json  a signed-in account's local copy of its cloud data
 * The renderer picks the file with setUser() whenever the sign-in changes.
 */
interface StoreData {
  projects: Project[]
  tabs: Tab[]
}

const empty = (): StoreData => ({ projects: [], tabs: [] })

// Supabase user ids are UUIDs; anything else must not become a file name.
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

class Store {
  private data: StoreData = empty()
  private file!: string
  private loaded = false
  private user: string | null = null

  private dataDir(): string {
    return join(app.getPath('userData'), 'data')
  }

  private fileFor(user: string | null): string {
    return user ? join(this.dataDir(), 'users', `${user}.json`) : join(this.dataDir(), 'store.json')
  }

  private async readFileData(file: string): Promise<StoreData> {
    if (!existsSync(file)) return empty()
    try {
      const d = JSON.parse(await readFile(file, 'utf8')) as Partial<StoreData>
      return { projects: d.projects ?? [], tabs: d.tabs ?? [] }
    } catch {
      return empty()
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.file = this.fileFor(this.user)
    // Not users/ for the signed-out file: its absence marks "not migrated yet".
    await mkdir(dirname(this.file), { recursive: true })
    this.data = await this.readFileData(this.file)
    this.loaded = true
    // No agent of a store that was just opened can be running yet.
    await this.markAllStopped()
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  /**
   * Switch to the signed-in account's projects (or the signed-out set for
   * null). Returns the ids of the tabs that belonged to the previous set, so
   * their agents can be stopped.
   *
   * One-time migration from before per-account files existed: the old
   * store.json belongs to whoever is signed in the first time this runs (the
   * renderer then uploads anything the cloud doesn't have yet).
   */
  async setUser(user: string | null): Promise<{ changed: boolean; previousTabIds: string[] }> {
    if (user !== null && !SAFE_ID.test(user)) throw new Error('Invalid user id.')
    if (this.loaded && user === this.user) return { changed: false, previousTabIds: [] }

    const usersDir = join(this.dataDir(), 'users')
    if (!existsSync(usersDir)) {
      await mkdir(usersDir, { recursive: true })
      const legacy = this.fileFor(null)
      if (user && existsSync(legacy) && !existsSync(this.fileFor(user))) {
        await rename(legacy, this.fileFor(user))
      }
    }

    const previousTabIds = this.loaded ? this.data.tabs.map((t) => t.id) : []
    this.user = user
    this.loaded = false
    await this.ensureLoaded()
    return { changed: true, previousTabIds }
  }

  /** The projects/tabs saved on this computer while signed out. */
  async guestData(): Promise<StoreData> {
    await this.ensureLoaded()
    if (this.user === null) return this.data
    return this.readFileData(this.fileFor(null))
  }

  /**
   * Move signed-out projects (and their tabs) into the signed-in account. They
   * leave the signed-out set, so they're not shown twice. Returns what moved.
   */
  async adoptGuestProjects(projectIds: string[]): Promise<StoreData> {
    await this.ensureLoaded()
    if (this.user === null) throw new Error('Not signed in.')
    const guestFile = this.fileFor(null)
    const guest = await this.readFileData(guestFile)
    const ids = new Set(projectIds)
    const moved: StoreData = {
      projects: guest.projects.filter((p) => ids.has(p.id)),
      tabs: guest.tabs
        .filter((t) => ids.has(t.projectId))
        .map((t) => ({ ...t, status: 'idle' as const }))
    }
    if (moved.projects.length === 0) return moved
    await this.importProjects(moved.projects)
    await this.importTabs(moved.tabs)
    const rest: StoreData = {
      projects: guest.projects.filter((p) => !ids.has(p.id)),
      tabs: guest.tabs.filter((t) => !ids.has(t.projectId))
    }
    await writeFile(guestFile, JSON.stringify(rest, null, 2), 'utf8')
    return moved
  }

  /**
   * Drop projects (with their tabs) and tabs from the list only, e.g. ones
   * deleted on another device. No processes or files are touched.
   */
  async removeEntries(projectIds: string[], tabIds: string[]): Promise<void> {
    await this.ensureLoaded()
    const p = new Set(projectIds)
    const t = new Set(tabIds)
    this.data.projects = this.data.projects.filter((x) => !p.has(x.id))
    this.data.tabs = this.data.tabs.filter((x) => !p.has(x.projectId) && !t.has(x.id))
    await this.persist()
  }

  async listProjects(): Promise<Project[]> {
    await this.ensureLoaded()
    return this.data.projects
  }

  async addProject(project: Project): Promise<void> {
    await this.ensureLoaded()
    this.data.projects.push(project)
    await this.persist()
  }

  async removeProject(projectId: string): Promise<void> {
    await this.ensureLoaded()
    this.data.projects = this.data.projects.filter((p) => p.id !== projectId)
    this.data.tabs = this.data.tabs.filter((t) => t.projectId !== projectId)
    await this.persist()
  }

  /**
   * Update a project. If its folder moved, tabs that ran directly in the old
   * folder follow it (worktree tabs keep their own path). Returns the updated
   * project + tabs.
   */
  async updateProject(
    projectId: string,
    patch: Partial<Project>
  ): Promise<{ project: Project; tabs: Tab[] } | null> {
    await this.ensureLoaded()
    const project = this.data.projects.find((p) => p.id === projectId)
    if (!project) return null
    const oldPath = project.localPath
    Object.assign(project, patch)
    const tabs = this.data.tabs.filter((t) => t.projectId === projectId)
    if (project.localPath !== oldPath) {
      for (const t of tabs) if (t.worktreePath === oldPath) t.worktreePath = project.localPath
    }
    await this.persist()
    return { project, tabs }
  }

  async listTabs(projectId?: string): Promise<Tab[]> {
    await this.ensureLoaded()
    return projectId ? this.data.tabs.filter((t) => t.projectId === projectId) : this.data.tabs
  }

  async addTab(tab: Tab): Promise<void> {
    await this.ensureLoaded()
    this.data.tabs.push(tab)
    await this.persist()
  }

  async updateTab(tabId: string, patch: Partial<Tab>): Promise<void> {
    await this.ensureLoaded()
    const tab = this.data.tabs.find((t) => t.id === tabId)
    if (tab) {
      Object.assign(tab, patch)
      await this.persist()
    }
  }

  async removeTab(tabId: string): Promise<void> {
    await this.ensureLoaded()
    this.data.tabs = this.data.tabs.filter((t) => t.id !== tabId)
    await this.persist()
  }

  /**
   * Insert-or-update projects/tabs (by id) into the local store. Used to
   * persist cloud-restored data so the backend store stays in sync with what
   * the UI shows — otherwise tab:create can't find a cloud-only project.
   */
  async importProjects(projects: Project[]): Promise<void> {
    await this.ensureLoaded()
    for (const p of projects) {
      const i = this.data.projects.findIndex((x) => x.id === p.id)
      if (i >= 0) this.data.projects[i] = p
      else this.data.projects.push(p)
    }
    await this.persist()
  }

  async importTabs(tabs: Tab[]): Promise<void> {
    await this.ensureLoaded()
    for (const t of tabs) {
      const i = this.data.tabs.findIndex((x) => x.id === t.id)
      if (i >= 0) this.data.tabs[i] = t
      else this.data.tabs.push(t)
    }
    await this.persist()
  }

  /**
   * A freshly opened store has no agent processes yet, so any tab persisted as
   * 'running'/'starting' is stale. Reset those to 'idle' so the UI shows them
   * as resumable rather than falsely live.
   */
  async markAllStopped(): Promise<void> {
    await this.ensureLoaded()
    let changed = false
    for (const t of this.data.tabs) {
      if (t.status === 'running' || t.status === 'starting') {
        t.status = 'idle'
        changed = true
      }
      // Backfill a session id for tabs created before session-resume existed.
      if (!t.sessionId) {
        t.sessionId = randomUUID()
        changed = true
      }
    }
    if (changed) await this.persist()
  }
}

export const store = new Store()
