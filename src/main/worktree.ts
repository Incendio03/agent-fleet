import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'

const run = promisify(execFile)

/**
 * Runs a git command inside `cwd` and returns trimmed stdout.
 * Throws with a readable message if git exits non-zero.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true })
    return stdout.trim()
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr || e.message}`)
  }
}

/** Is this path the root (or inside) a git repository? */
export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const out = await git(path, ['rev-parse', '--is-inside-work-tree'])
    return out === 'true'
  } catch {
    return false
  }
}

/** Turn an arbitrary task title into a safe git branch name. */
export function slugifyBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `agent/${slug || 'task'}`
}

export interface WorktreeInfo {
  branch: string
  worktreePath: string
}

/**
 * Creates an isolated git worktree for an agent task.
 *
 * A worktree is a second working folder for the same repo, checked out on its
 * own branch — so two agents can edit "the same project" without ever touching
 * each other's files. We branch from the repo's current HEAD.
 *
 * @param repoPath   the project's main repo on disk
 * @param title      human task title, used to derive a branch name
 * @param worktreeRoot  where worktree folders are created (defaults next to repo)
 */
export async function createWorktree(
  repoPath: string,
  title: string,
  worktreeRoot?: string
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(repoPath))) {
    throw new Error(
      `"${repoPath}" is not a git repository. Initialise it with git first (git init && git commit).`
    )
  }

  const baseBranch = slugifyBranch(title)
  const root = worktreeRoot || join(repoPath, '..', `${basename(repoPath)}-worktrees`)
  await mkdir(root, { recursive: true })

  // Branch and folder names must be unique — append a counter on collision.
  let branch = baseBranch
  let worktreePath = join(root, branch.replace(/\//g, '-'))
  let n = 1
  while ((await branchExists(repoPath, branch)) || existsSync(worktreePath)) {
    n += 1
    branch = `${baseBranch}-${n}`
    worktreePath = join(root, branch.replace(/\//g, '-'))
  }

  // Create the worktree on a brand-new branch rooted at current HEAD.
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])

  return { branch, worktreePath }
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Removes a worktree folder and (optionally) deletes its branch.
 * Called when a tab is closed. Uses --force because the agent may have left
 * uncommitted changes; we surface that choice to the user in the UI first.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  deleteBranch = false
): Promise<void> {
  if (existsSync(worktreePath)) {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(async () => {
      // If git refuses (e.g. corrupt entry), fall back to pruning + manual rm.
      await rm(worktreePath, { recursive: true, force: true })
      await git(repoPath, ['worktree', 'prune']).catch(() => {})
    })
  }
  if (deleteBranch) {
    await git(repoPath, ['branch', '-D', branch]).catch(() => {})
  }
}

/** Does the worktree have uncommitted changes? Used to warn before closing. */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false
  try {
    const out = await git(worktreePath, ['status', '--porcelain'])
    return out.length > 0
  } catch {
    return false
  }
}
