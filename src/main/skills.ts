import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentKind, SkillFile, SkillInfo, SkillStage, StagedSkill } from '@shared/types'

const run = promisify(execFile)

/**
 * Skills: folders holding a SKILL.md (a short front-matter header with a name
 * and description, then instructions), plus any files it refers to. Each agent
 * CLI loads them from its own folders:
 *
 *   Claude Code  <config>/skills/<name>        personal (we install here)
 *                <config>/skills/synced/…/<name>  synced from the Claude account
 *                <project>/.claude/skills/<name>  per project
 *   Codex        <CODEX_HOME>/skills/<name>     personal (we install here)
 *                <CODEX_HOME>/skills/.system/<name>  built in
 *
 * Turning a personal skill off moves it to a sibling "skills-disabled" folder,
 * which the CLIs don't read; turning it on moves it back. Removing sends it to
 * the Recycle Bin. Installing always goes through a review step (stage), so
 * nothing lands in a skills folder without being looked at first.
 *
 * No Electron imports: whatever needs Electron comes in as a parameter.
 */

export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const codexDir = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

const homeOf = (agent: AgentKind): string => (agent === 'codex' ? codexDir() : claudeDir())
export const skillsDir = (agent: AgentKind): string => join(homeOf(agent), 'skills')
const disabledDir = (agent: AgentKind): string => join(homeOf(agent), 'skills-disabled')

/** Folder names a skill may have (what the CLIs accept, and safe as a path). */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const SCRIPT_EXT = new Set([
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl',
  '.php', '.exe', '.dll', '.jar', '.vbs', '.msi', '.com', '.scr', '.lua', '.go', '.rs', '.so', '.dylib'
])
const isScript = (p: string): boolean => SCRIPT_EXT.has(extname(p).toLowerCase())

// ---- SKILL.md header ----------------------------------------------------------

export interface SkillHeader {
  name?: string
  description?: string
  allowedTools?: string
  body: string
}

/** Read the `---` front-matter of a SKILL.md (the few simple YAML forms skills use). */
export function parseSkillMd(text: string): SkillHeader {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src)
  if (!m) return { body: src }
  const lines = m[1].split('\n')
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let value = kv[2].trim()
    if (/^[>|][+-]?$/.test(value) || value === '') {
      // Block value: the indented lines that follow.
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^["']/.test(value)) {
      const q = value[0]
      value = value.slice(1, value.lastIndexOf(q) > 0 ? value.lastIndexOf(q) : undefined)
      if (q === '"') value = value.replace(/\\"/g, '"').replace(/\\n/g, '\n')
      else value = value.replace(/''/g, "'")
    }
    out[key] = value
  }
  return {
    name: out.name,
    description: out.description,
    allowedTools: out['allowed-tools'],
    body: src.slice(m[0].length)
  }
}

// ---- reading what's installed ---------------------------------------------------

async function filesUnder(dir: string, limit = 5000): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  const walk = async (d: string): Promise<void> => {
    if (out.length >= limit) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        await walk(full)
      } else if (e.isFile()) {
        const s = await stat(full).catch(() => null)
        out.push({ path: relative(dir, full).split(sep).join('/'), size: s?.size ?? 0 })
      }
    }
  }
  await walk(dir)
  return out
}

/** One skill folder -> SkillInfo (null if it has no SKILL.md). */
async function readSkill(
  agent: AgentKind,
  dir: string,
  scope: SkillInfo['scope'],
  enabled: boolean,
  project?: string
): Promise<SkillInfo | null> {
  const md = join(dir, 'SKILL.md')
  if (!existsSync(md)) return null
  let header: SkillHeader
  try { header = parseSkillMd(await readFile(md, 'utf8')) } catch { return null }
  const files = (await filesUnder(dir, 500)).filter((f) => f.path !== 'SKILL.md')
  return {
    agent,
    name: basename(dir),
    description: (header.description ?? '').replace(/\s+/g, ' ').trim(),
    scope,
    ...(project ? { project } : {}),
    enabled,
    path: dir,
    files: files.length,
    hasScripts: files.some((f) => isScript(f.path))
  }
}

async function skillsIn(agent: AgentKind, parent: string, scope: SkillInfo['scope'], enabled: boolean, project?: string): Promise<SkillInfo[]> {
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(parent, { withFileTypes: true }) } catch { return [] }
  const found = await Promise.all(
    entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && e.name !== 'synced')
      .map((e) => readSkill(agent, join(parent, e.name), scope, enabled, project))
  )
  return found.filter((s): s is SkillInfo => s != null)
}

/** Everything an agent has installed (projects: the user's projects, for project skills). */
export async function listSkills(agent: AgentKind, projects: { name: string; localPath: string }[] = []): Promise<SkillInfo[]> {
  const list: SkillInfo[] = [
    ...(await skillsIn(agent, skillsDir(agent), 'personal', true)),
    ...(await skillsIn(agent, disabledDir(agent), 'personal', false))
  ]
  if (agent === 'claude') {
    // Synced from the Claude account: skills/synced/<bucket>/<skill>.
    const synced = join(skillsDir('claude'), 'synced')
    for (const bucket of await readdir(synced, { withFileTypes: true }).catch(() => [])) {
      if (bucket.isDirectory() && !bucket.name.startsWith('.')) list.push(...(await skillsIn(agent, join(synced, bucket.name), 'synced', true)))
    }
    for (const p of projects) list.push(...(await skillsIn(agent, join(p.localPath, '.claude', 'skills'), 'project', true, p.name)))
  } else {
    list.push(...(await skillsIn(agent, join(skillsDir('codex'), '.system'), 'builtin', true)))
  }
  const order = { personal: 0, project: 1, synced: 2, builtin: 3 }
  return list.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name))
}

/** A personal skill's folder, wherever it is (on or off). Throws if there's none. */
function personalPath(agent: AgentKind, name: string): { path: string; enabled: boolean } {
  if (!NAME.test(name)) throw new Error('Invalid skill name.')
  const on = join(skillsDir(agent), name)
  if (existsSync(join(on, 'SKILL.md'))) return { path: on, enabled: true }
  const off = join(disabledDir(agent), name)
  if (existsSync(join(off, 'SKILL.md'))) return { path: off, enabled: false }
  throw new Error(`There's no personal skill called "${name}".`)
}

export async function setSkillEnabled(agent: AgentKind, name: string, enabled: boolean): Promise<void> {
  const cur = personalPath(agent, name)
  if (cur.enabled === enabled) return
  const target = join(enabled ? skillsDir(agent) : disabledDir(agent), name)
  if (existsSync(target)) throw new Error(`A skill folder called "${name}" is already there. Remove one of them first.`)
  await mkdir(join(target, '..'), { recursive: true })
  await rename(cur.path, target)
}

/** Send a personal skill to the Recycle Bin (`trash` is Electron's shell.trashItem). */
export async function removeSkill(agent: AgentKind, name: string, trash: (path: string) => Promise<void>): Promise<void> {
  await trash(personalPath(agent, name).path)
}

/** SKILL.md and file list of any installed skill, for viewing. */
export async function readSkillDetails(path: string, allowedRoots: string[]): Promise<{ skillMd: string; files: SkillFile[] }> {
  // Only folders we listed: a skills folder of an agent or project.
  const norm = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '')
  if (!allowedRoots.some((r) => norm(path).startsWith(norm(r) + sep.toLowerCase()) || norm(path).startsWith(norm(r) + '/'))) {
    throw new Error('Not a skill folder.')
  }
  const text = await readFile(join(path, 'SKILL.md'), 'utf8')
  const files = (await filesUnder(path, 500)).map((f) => ({ ...f, script: isScript(f.path) }))
  return { skillMd: clip(text, 60_000), files }
}

/** Every folder a listed skill can live in (for readSkillDetails' check). */
export function skillRoots(projects: { localPath: string }[]): string[] {
  return [
    skillsDir('claude'), disabledDir('claude'), skillsDir('codex'), disabledDir('codex'),
    ...projects.map((p) => join(p.localPath, '.claude', 'skills'))
  ]
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n\n… (cut off: ${s.length - n} more characters)` : s)

// ---- installing: stage (look inside) -> review -> install ------------------------

const MAX_FILES = 2000
const MAX_BYTES = 50 * 1024 * 1024
const stages = new Map<string, { dir: string; source: string; skills: StagedSkill[] }>()

/** Copy a folder without following links (a skill must not smuggle in files from elsewhere). */
async function copyTree(from: string, to: string): Promise<void> {
  let count = 0
  let bytes = 0
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (src) => {
      const s = await lstat(src)
      if (s.isSymbolicLink()) return false
      const name = basename(src)
      if (s.isDirectory() && (name === '.git' || name === 'node_modules')) return false
      if (s.isFile()) {
        count++
        bytes += s.size
        if (count > MAX_FILES || bytes > MAX_BYTES) throw new Error('That is too big to be a skill (over 2000 files or 50 MB).')
      }
      return true
    }
  })
}

/** Parse a GitHub link: repo, and optionally /tree/<ref>/<path> or /blob/… */
export function parseGitHub(url: string): { repo: string; parts: string[] } {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/(.+?))?\/?(?:[?#].*)?$/.exec(url.trim())
  if (!m) throw new Error('Use a GitHub link like https://github.com/owner/repo or …/tree/main/path/to/skill.')
  return { repo: `https://github.com/${m[1]}/${m[2]}.git`, parts: m[3] ? m[3].split('/').filter(Boolean) : [] }
}

async function fetchGitHub(url: string, dest: string): Promise<{ root: string; label: string }> {
  const { repo, parts } = parseGitHub(url)
  const git = (args: string[]): Promise<{ stdout: string }> =>
    run('git', ['-c', 'core.longpaths=true', ...args], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
  // Download the history's file list only (no file contents, nothing checked
  // out), then check out just the skill folders. Repositories often hold other
  // files too, some of which Windows can't even create (names with ':' etc.).
  const clone = async (ref?: string): Promise<void> => {
    await rm(dest, { recursive: true, force: true })
    await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...(ref ? ['--branch', ref, '--single-branch'] : []), repo, dest])
  }
  // tree/<ref>/<path>: the ref may itself contain "/", so try the shortest first.
  let sub: string[] = []
  let cloned = false
  for (let k = 1; k <= Math.min(parts.length, 3) && !cloned; k++) {
    try {
      await clone(parts.slice(0, k).join('/'))
      sub = parts.slice(k)
      cloned = true
    } catch (err) {
      if (k === Math.min(parts.length, 3)) throw cloneError(err)
    }
  }
  if (!cloned) {
    try { await clone() } catch (err) { throw cloneError(err) }
  }

  const prefix = sub.join('/')
  const all = (await git(['-C', dest, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const inside = prefix ? all.filter((f) => f === prefix || f.startsWith(prefix + '/')) : all
  if (prefix && !inside.length) throw new Error(`"${prefix}" isn't in that repository.`)
  const skillDirs = [...new Set(inside.filter((f) => f === 'SKILL.md' || f.endsWith('/SKILL.md')).map((f) => f.slice(0, -'SKILL.md'.length).replace(/\/$/, '')))]
    .filter((d) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(d))
    .slice(0, 100)
  if (!skillDirs.length) throw new Error('No skill found there: a skill is a folder with a SKILL.md file in it.')
  // Sparse checkout of exactly those folders.
  const patterns = skillDirs.map((d) => (d ? `/${d}/` : '/*'))
  await git(['-C', dest, 'config', 'core.sparseCheckout', 'true'])
  await git(['-C', dest, 'config', 'core.sparseCheckoutCone', 'false'])
  await mkdir(join(dest, '.git', 'info'), { recursive: true })
  await writeFile(join(dest, '.git', 'info', 'sparse-checkout'), patterns.join('\n') + '\n')
  try {
    await git(['-C', dest, 'checkout'])
  } catch (err) {
    throw new Error(`Couldn't get the skill files from that repository: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').pop()}`)
  }
  await rm(join(dest, '.git'), { recursive: true, force: true })
  return { root: prefix ? join(dest, ...sub) : dest, label: url.trim() }
}

function cloneError(err: unknown): Error {
  const e = err as { code?: string; stderr?: string; message?: string }
  if (e.code === 'ENOENT') return new Error('Git is needed to install from GitHub, and it was not found.')
  const msg = String(e.stderr || e.message || err)
  if (/not found|Could not read|Authentication|terminal prompts disabled/i.test(msg)) {
    return new Error("Couldn't download that repository. Check the link (private repositories aren't supported).")
  }
  return new Error(`Couldn't download that repository: ${msg.split('\n').filter(Boolean).pop()}`)
}

async function extractZip(zip: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  // Windows 10+ and macOS ship bsdtar, which reads zip files and refuses
  // entries that would land outside the folder (absolute paths, "..").
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  try {
    await run(tar, ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 120_000 })
  } catch (err) {
    throw new Error(`Couldn't open that zip file: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').pop()}`)
  }
}

/** Folders containing a SKILL.md, a few levels down (the source may hold several skills). */
async function findSkillDirs(root: string, depth = 5): Promise<string[]> {
  if (existsSync(join(root, 'SKILL.md'))) return [root]
  if (depth === 0) return []
  const out: string[] = []
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
    out.push(...(await findSkillDirs(join(root, e.name), depth - 1)))
    if (out.length > 100) break
  }
  return out
}

async function describeStaged(root: string, dir: string): Promise<StagedSkill> {
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const h = parseSkillMd(text)
  const files = (await filesUnder(dir, MAX_FILES)).map((f) => ({ ...f, script: isScript(f.path) }))
  const folder = basename(dir)
  const name = (h.name ?? '').trim() || folder
  const errors: string[] = []
  const warnings: string[] = []
  if (!NAME.test(name)) errors.push(`Its name "${name}" isn't valid: use lowercase letters, numbers and dashes.`)
  if (!h.description?.trim()) errors.push('Its SKILL.md has no description, so the agent wouldn\'t know when to use it.')
  if (!/^---\n/.test(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))) errors.push('Its SKILL.md has no header (the --- block with name and description).')
  const scripts = files.filter((f) => f.script)
  if (scripts.length) {
    warnings.push(
      `Contains ${scripts.length === 1 ? 'a script or program' : `${scripts.length} scripts or programs`}. ` +
        'Agents can run these with their own permissions, so only install it if you trust where it comes from.'
    )
  }
  if (h.allowedTools) warnings.push(`It asks to use these tools without asking you first: ${h.allowedTools}.`)
  return {
    dir: relative(root, dir).split(sep).join('/'),
    name,
    description: (h.description ?? '').replace(/\s+/g, ' ').trim(),
    files,
    skillMd: clip(text, 60_000),
    ...(h.allowedTools ? { allowedTools: h.allowedTools } : {}),
    errors,
    warnings
  }
}

/**
 * Copy what's being installed into a private staging folder and look inside.
 * Nothing is installed yet: the result is shown for review first.
 */
export async function stageSkills(
  source: { kind: 'folder' | 'zip'; path: string } | { kind: 'github'; url: string },
  stagingRoot: string
): Promise<SkillStage> {
  const id = randomUUID()
  const dir = join(stagingRoot, id)
  await mkdir(dir, { recursive: true })
  try {
    let root = join(dir, 'src')
    let label: string
    if (source.kind === 'github') {
      const got = await fetchGitHub(source.url, root)
      root = got.root
      label = got.label
    } else if (source.kind === 'zip') {
      await extractZip(source.path, root)
      label = source.path
    } else {
      await copyTree(source.path, root)
      label = source.path
    }
    const dirs = await findSkillDirs(root)
    if (!dirs.length) throw new Error('No skill found there: a skill is a folder with a SKILL.md file in it.')
    const skills = await Promise.all(dirs.map((d) => describeStaged(root, d)))
    // Two skills with the same name can't both be installed.
    const seen = new Map<string, number>()
    for (const s of skills) seen.set(s.name, (seen.get(s.name) ?? 0) + 1)
    for (const s of skills) if ((seen.get(s.name) ?? 0) > 1) s.errors.push(`More than one skill here is called "${s.name}".`)
    stages.set(id, { dir: root, source: label, skills })
    return { id, source: label, skills }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Install reviewed skills (by their `dir` in the stage) for an agent. A skill
 * that's already installed under the same name is only replaced with
 * `replace` (the old one goes to the Recycle Bin). Returns the installed names.
 */
export async function installStaged(
  stageId: string,
  agent: AgentKind,
  dirs: string[],
  replace: boolean,
  trash: (path: string) => Promise<void>,
  stagingRoot: string
): Promise<string[]> {
  const stage = stages.get(stageId)
  if (!stage) throw new Error('That install expired. Pick the skill again.')
  const chosen = stage.skills.filter((s) => dirs.includes(s.dir))
  if (!chosen.length) throw new Error('Pick at least one skill to install.')
  const bad = chosen.find((s) => s.errors.length)
  if (bad) throw new Error(`"${bad.name}" can't be installed: ${bad.errors[0]}`)

  const conflicts = chosen.filter((s) => existsSync(join(skillsDir(agent), s.name)) || existsSync(join(disabledDir(agent), s.name)))
  if (conflicts.length && !replace) {
    throw new Error(`Already installed: ${conflicts.map((c) => c.name).join(', ')}. Choose to replace ${conflicts.length === 1 ? 'it' : 'them'} to continue.`)
  }
  await mkdir(skillsDir(agent), { recursive: true })
  for (const s of conflicts) {
    for (const old of [join(skillsDir(agent), s.name), join(disabledDir(agent), s.name)]) if (existsSync(old)) await trash(old)
  }
  for (const s of chosen) await copyTree(join(stage.dir, ...s.dir.split('/').filter(Boolean)), join(skillsDir(agent), s.name))
  await discardStage(stageId, stagingRoot)
  return chosen.map((s) => s.name)
}

export async function discardStage(stageId: string, stagingRoot: string): Promise<void> {
  stages.delete(stageId)
  if (/^[0-9a-f-]{36}$/i.test(stageId)) await rm(join(stagingRoot, stageId), { recursive: true, force: true }).catch(() => undefined)
}

// ---- skills in general chats ---------------------------------------------------

/** The chat's chosen skills that are installed and turned on, with their folders. */
async function chosenSkills(agent: AgentKind, names: string[]): Promise<{ name: string; path: string }[]> {
  return names
    .filter((n) => NAME.test(n))
    .map((n) => ({ name: n, path: join(skillsDir(agent), n) }))
    .filter((s) => existsSync(join(s.path, 'SKILL.md')))
}

/**
 * Claude chat: a small plugin holding copies of just the chosen skills, which
 * the chat process loads with --plugin-dir. Copies (not links) so the chat's
 * file access can stay confined to this folder. Null when none are available.
 */
export async function buildChatPlugin(chatId: string, names: string[], root: string): Promise<{ dir: string; names: string[] } | null> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(chatId)) return null
  const dir = join(root, chatId)
  await rm(dir, { recursive: true, force: true })
  const skills = await chosenSkills('claude', names)
  if (!skills.length) return null
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'chat-skills', version: '1.0.0', description: 'Skills chosen for this Agent Fleet chat' }, null, 2)
  )
  for (const s of skills) await copyTree(s.path, join(dir, 'skills', s.name))
  return { dir, names: skills.map((s) => s.name) }
}

export async function removeChatPlugin(chatId: string, root: string): Promise<void> {
  if (/^[A-Za-z0-9-]{1,64}$/.test(chatId)) await rm(join(root, chatId), { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Codex chat (and Claude without plugin support): the chosen skills'
 * instructions as text for the chat's instructions. Their other files can't be
 * opened from a chat, so this suits instruction-only skills best.
 */
export async function skillInstructions(agent: AgentKind, names: string[], max = 40_000): Promise<string> {
  const parts: string[] = []
  let size = 0
  for (const s of await chosenSkills(agent, names)) {
    const h = parseSkillMd(await readFile(join(s.path, 'SKILL.md'), 'utf8').catch(() => ''))
    const piece = `## Skill: ${s.name}\n${h.description ? `Use when: ${h.description}\n` : ''}\n${h.body.trim()}`
    if (size + piece.length > max) break
    parts.push(piece)
    size += piece.length
  }
  if (!parts.length) return ''
  return `The user turned on these skills for this chat. Follow a skill's instructions whenever its "Use when" applies.\n\n${parts.join('\n\n')}`
}
