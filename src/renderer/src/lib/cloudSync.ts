import { supabase } from './supabase'
import type { Project, Tab } from '@shared/types'

/**
 * Mirrors the signed-in account's projects/tabs to Supabase and back.
 *
 * Every function is a no-op when cloud sync is off or nobody is signed in, so
 * the rest of the app can call these unconditionally. We don't send `user_id`
 * from the client — the DB column defaults to auth.uid(), and RLS enforces that
 * a row can only ever belong to the logged-in user.
 *
 * While signed in, the account's projects mirror the cloud (see reconcile):
 * things deleted on another device disappear here too. To tell "deleted
 * elsewhere" apart from "created here and not uploaded yet", we remember per
 * account which ids the cloud is known to have (seen in a pull or uploaded).
 * Deletes are queued until they go through, so offline deletes are retried
 * and a sync running meanwhile doesn't bring the row back.
 */
async function sessionUser(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

// ---- per-account sync bookkeeping (localStorage) ---------------------------
const KNOWN = (user: string): string => `fleet.cloudIds.${user}`
const PENDING_DELETES = (user: string): string => `fleet.cloudDeletes.${user}`

function loadSet(key: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function saveSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]))
  } catch {
    // storage unavailable: worst case, a later sync re-uploads instead of deleting
  }
}
function updateSet(key: string, fn: (s: Set<string>) => void): void {
  const s = loadSet(key)
  fn(s)
  saveSet(key, s)
}

// ---- row <-> domain mapping ------------------------------------------------
function projectToRow(p: Project): Record<string, unknown> {
  return { id: p.id, name: p.name, local_path: p.localPath, github_url: p.githubUrl ?? null }
}
function rowToProject(r: Record<string, any>): Project {
  return {
    id: r.id,
    name: r.name,
    localPath: r.local_path,
    githubUrl: r.github_url ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now()
  }
}

// Set false when the database predates migration 0003 (no `agent` column), so
// sync keeps working, just without the agent kind, until the migration is run.
let hasAgentColumn = true

function tabToRow(t: Tab): Record<string, unknown> {
  return {
    id: t.id,
    project_id: t.projectId,
    ...(hasAgentColumn ? { agent: t.agent ?? 'claude' } : {}),
    title: t.title,
    task: t.task,
    model: t.model,
    effort: t.effort,
    permission_mode: t.permissionMode,
    branch: t.branch,
    worktree_path: t.worktreePath,
    session_id: t.sessionId,
    status: t.status,
    exit_code: t.exitCode ?? null
  }
}
function rowToTab(r: Record<string, any>): Tab {
  return {
    id: r.id,
    projectId: r.project_id,
    agent: r.agent ?? undefined,
    title: r.title,
    task: r.task,
    model: r.model,
    effort: r.effort,
    permissionMode: r.permission_mode,
    branch: r.branch,
    worktreePath: r.worktree_path,
    sessionId: r.session_id ?? '',
    status: r.status,
    exitCode: r.exit_code ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now()
  }
}

// ---- push ------------------------------------------------------------------
export async function pushProject(p: Project): Promise<void> {
  const user = await sessionUser()
  if (!supabase || !user) return
  const { error } = await supabase.from('projects').upsert(projectToRow(p))
  if (!error) updateSet(KNOWN(user), (s) => s.add(p.id))
}
export async function pushTab(t: Tab): Promise<void> {
  const user = await sessionUser()
  if (!supabase || !user) return
  let { error } = await supabase.from('tabs').upsert(tabToRow(t))
  // PGRST204: a column in the payload doesn't exist (0003 not run yet).
  if (error && hasAgentColumn && error.code === 'PGRST204' && /agent/.test(error.message)) {
    hasAgentColumn = false
    ;({ error } = await supabase.from('tabs').upsert(tabToRow(t)))
  }
  if (!error) updateSet(KNOWN(user), (s) => s.add(t.id))
}

async function deleteRow(table: 'projects' | 'tabs', id: string, user: string): Promise<void> {
  if (!supabase) return
  const key = `${table === 'projects' ? 'p' : 't'}:${id}`
  updateSet(PENDING_DELETES(user), (s) => s.add(key))
  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) return // stays queued; retried by the next reconcile
  updateSet(PENDING_DELETES(user), (s) => s.delete(key))
  updateSet(KNOWN(user), (s) => s.delete(id))
}
export async function deleteProjectCloud(id: string): Promise<void> {
  const user = await sessionUser()
  if (user) await deleteRow('projects', id, user)
}
export async function deleteTabCloud(id: string): Promise<void> {
  const user = await sessionUser()
  if (user) await deleteRow('tabs', id, user)
}

// ---- pull ------------------------------------------------------------------
export interface CloudSnapshot {
  projects: Project[]
  tabs: Tab[]
}

/**
 * Fetch everything that belongs to the logged-in user (RLS scopes it). Null on
 * any error: an empty result must never be mistaken for "everything deleted".
 */
export async function pullAll(): Promise<CloudSnapshot | null> {
  if (!supabase || !(await sessionUser())) return null
  const [projects, tabs] = await Promise.all([
    supabase.from('projects').select('*'),
    supabase.from('tabs').select('*')
  ])
  if (projects.error || tabs.error || !projects.data || !tabs.data) return null
  return {
    projects: projects.data.map(rowToProject),
    tabs: tabs.data.map(rowToTab)
  }
}

// ---- reconcile -------------------------------------------------------------
export interface SyncChanges {
  /** In the cloud, not here yet. */
  addProjects: Project[]
  addTabs: Tab[]
  /** Here, but deleted on another device. */
  removeProjectIds: string[]
  removeTabIds: string[]
}

/**
 * Bring this device's copy of the account in line with the cloud: retries
 * queued deletes, uploads what was never uploaded, and returns what to add and
 * what was deleted elsewhere. Null when signed out or the cloud is unreachable.
 */
export async function reconcile(local: CloudSnapshot): Promise<SyncChanges | null> {
  const user = await sessionUser()
  if (!supabase || !user) return null

  for (const key of loadSet(PENDING_DELETES(user))) {
    await deleteRow(key.startsWith('p:') ? 'projects' : 'tabs', key.slice(2), user)
  }
  const pending = loadSet(PENDING_DELETES(user))

  const snap = await pullAll()
  if (!snap) return null
  const known = loadSet(KNOWN(user))

  const cloudProjectIds = new Set(snap.projects.map((p) => p.id))
  const cloudPaths = new Set(snap.projects.map((p) => p.localPath))
  const cloudTabIds = new Set(snap.tabs.map((t) => t.id))
  const localProjectIds = new Set(local.projects.map((p) => p.id))
  const localPaths = new Set(local.projects.map((p) => p.localPath))
  const localTabIds = new Set(local.tabs.map((t) => t.id))

  // Deleted elsewhere: the cloud had it before and doesn't now.
  const removeProjectIds = local.projects
    .filter((p) => !cloudProjectIds.has(p.id) && known.has(p.id))
    .map((p) => p.id)
  const removedProjects = new Set(removeProjectIds)
  const removeTabIds = local.tabs
    .filter((t) => removedProjects.has(t.projectId) || (!cloudTabIds.has(t.id) && known.has(t.id)))
    .map((t) => t.id)

  // New in the cloud. The same folder under another id is the same project: skip.
  const addProjects = snap.projects.filter(
    (p) => !localProjectIds.has(p.id) && !localPaths.has(p.localPath) && !pending.has(`p:${p.id}`)
  )
  const projectIds = new Set([...localProjectIds, ...addProjects.map((p) => p.id)])
  const addTabs = snap.tabs.filter(
    (t) =>
      !localTabIds.has(t.id) &&
      projectIds.has(t.projectId) &&
      !removedProjects.has(t.projectId) &&
      !pending.has(`t:${t.id}`)
  )

  // Remember what the cloud has now.
  for (const id of [...cloudProjectIds, ...cloudTabIds]) known.add(id)
  for (const id of [...removeProjectIds, ...removeTabIds]) known.delete(id)
  saveSet(KNOWN(user), known)

  // Never uploaded (created offline, or before syncing existed): upload now.
  for (const p of local.projects) {
    if (!cloudProjectIds.has(p.id) && !known.has(p.id) && !cloudPaths.has(p.localPath)) await pushProject(p)
  }
  for (const t of local.tabs) {
    if (!cloudTabIds.has(t.id) && !known.has(t.id) && !removedProjects.has(t.projectId)) await pushTab(t)
  }

  return { addProjects, addTabs, removeProjectIds, removeTabIds }
}
