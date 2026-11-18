import { app } from 'electron'
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
}

export const store = new Store()
