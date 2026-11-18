import { supabase } from './supabase'
import type { Project, Tab } from '@shared/types'

/**
 * Mirrors local projects/tabs to Supabase and pulls them back on login.
 *
 * Every function is a no-op when cloud sync is off or nobody is signed in, so
 * the rest of the app can call these unconditionally. We don't send `user_id`
 * from the client — the DB column defaults to auth.uid(), and RLS enforces that
 * a row can only ever belong to the logged-in user.
 */
async function signedIn(): Promise<boolean> {
  if (!supabase) return false
  const { data } = await supabase.auth.getSession()
  return Boolean(data.session)
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
function tabToRow(t: Tab): Record<string, unknown> {
  return {
    id: t.id,
    project_id: t.projectId,
    title: t.title,
    task: t.task,
    model: t.model,
    effort: t.effort,
    permission_mode: t.permissionMode,
    branch: t.branch,
    worktree_path: t.worktreePath,
    status: t.status,
    exit_code: t.exitCode ?? null
  }
}
function rowToTab(r: Record<string, any>): Tab {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    task: r.task,
    model: r.model,
    effort: r.effort,
    permissionMode: r.permission_mode,
    branch: r.branch,
    worktreePath: r.worktree_path,
    status: r.status,
    exitCode: r.exit_code ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now()
  }
}

// ---- push ------------------------------------------------------------------
export async function pushProject(p: Project): Promise<void> {
  if (!supabase || !(await signedIn())) return
  await supabase.from('projects').upsert(projectToRow(p))
}
export async function pushTab(t: Tab): Promise<void> {
  if (!supabase || !(await signedIn())) return
  await supabase.from('tabs').upsert(tabToRow(t))
}
export async function deleteProjectCloud(id: string): Promise<void> {
  if (!supabase || !(await signedIn())) return
  await supabase.from('projects').delete().eq('id', id)
}
export async function deleteTabCloud(id: string): Promise<void> {
  if (!supabase || !(await signedIn())) return
  await supabase.from('tabs').delete().eq('id', id)
}

// ---- pull ------------------------------------------------------------------
export interface CloudSnapshot {
  projects: Project[]
  tabs: Tab[]
}

/** Fetch everything that belongs to the logged-in user (RLS scopes it). */
export async function pullAll(): Promise<CloudSnapshot | null> {
  if (!supabase || !(await signedIn())) return null
  const [{ data: projects }, { data: tabs }] = await Promise.all([
    supabase.from('projects').select('*'),
    supabase.from('tabs').select('*')
  ])
  return {
    projects: (projects ?? []).map(rowToProject),
    tabs: (tabs ?? []).map(rowToTab)
  }
}
