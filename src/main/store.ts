import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Project, Tab } from '@shared/types'

/**
 * Local persistence for projects and tabs.
 *
 * This is the on-disk source of truth the app always reads/writes, so it works
 * fully offline. When Supabase is configured, the renderer mirrors this up to
 * the cloud (and pulls it back down on whatever device you sign in from).
 * Keeping a local JSON file means the app never blocks on the network.
 */
interface StoreData {
  projects: Project[]
  tabs: Tab[]
}

const EMPTY: StoreData = { projects: [], tabs: [] }

class Store {
  private data: StoreData = EMPTY
  private file!: string
  private loaded = false

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const dir = join(app.getPath('userData'), 'data')
    await mkdir(dir, { recursive: true })
    this.file = join(dir, 'store.json')
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(await readFile(this.file, 'utf8')) as StoreData
      } catch {
        this.data = { ...EMPTY }
      }
    } else {
      this.data = { ...EMPTY }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
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
   * On startup no agent processes exist yet, so any tab persisted as
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
