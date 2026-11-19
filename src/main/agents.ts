import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { AgentInfo, AgentKind, AgentStatus, Tab } from '@shared/types'
import { buildClaudeCommand, detectClaude, type SpawnCommand } from './claude'

const run = promisify(execFile)

/**
 * Registry of agent CLIs a tab can run. Everything shown in the UI (which
 * agents exist, their models and effort levels) is DETECTED on this machine,
 * not hard-coded, so new CLI versions/models show up automatically.
 */

/** How to run a CLI: an executable plus any leading args (e.g. node + script). */
export interface ResolvedCommand {
  file: string
  prefix: string[]
}

async function lookup(cmd: string): Promise<string[]> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true })
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter((p) => p && existsSync(p))
  } catch {
    return []
  }
}

/**
 * Find a runnable command. On Windows, `where` can list an extensionless npm
 * shell script FIRST (e.g. ...\npm\codex), which Windows can't execute (error
 * 193). So prefer a real .exe; for an npm .cmd shim, run its JS entry point
 * with Node directly (avoids cmd.exe argument quoting); else cmd.exe /c.
 */
async function resolveCommand(cmd: string): Promise<ResolvedCommand | null> {
  const hits = await lookup(cmd)
  if (process.platform !== 'win32') return hits[0] ? { file: hits[0], prefix: [] } : null
  const exe = hits.find((h) => /\.exe$/i.test(h))
  if (exe) return { file: exe, prefix: [] }
  const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h))
  if (!shim) return null
  try {
    const m = /"%dp0%\\([^"]+\.js)"/i.exec(await readFile(shim, 'utf8'))
    const node = (await lookup('node')).find((h) => /\.exe$/i.test(h))
    if (m && node) {
      const script = join(dirname(shim), m[1])
      if (existsSync(script)) return { file: node, prefix: [script] }
    }
  } catch {
    /* fall through */
  }
  return { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/c', shim] }
}

/** Claude Code: efforts from `--effort <level> (low, medium, ...)`, models from the --model help aliases. */
async function detectClaudeAgent(): Promise<AgentInfo> {
  const caps = await detectClaude()
  const help = caps.helpText
  const available = help.length > 0
  const effortM = /--effort\b[\s\S]*?\(([a-z, ]+)\)/.exec(help)
  const efforts = effortM ? effortM[1].split(',').map((s) => s.trim()).filter(Boolean) : ['low', 'medium', 'high']
  const modelBlock = /--model\b[\s\S]*?(?=\n\s{2}-)/.exec(help)?.[0] ?? ''
  const aliases = [...modelBlock.matchAll(/'([a-z0-9.-]+)'/g)].map((m) => m[1])
  const models = [...new Set([...aliases, 'haiku'])].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), efforts }))
  return {
    id: 'claude',
    label: 'Claude Code',
    available,
    models,
    efforts,
    supportsResume: caps.supportsResume || caps.supportsContinue,
    supportsTeam: caps.supportsName
  }
}

/** Codex: models + per-model efforts from ~/.codex/models_cache.json (kept fresh by Codex itself). */
async function detectCodexAgent(): Promise<AgentInfo> {
  const path = await resolveCommand('codex')
  const base: AgentInfo = {
    id: 'codex',
    label: 'Codex',
    available: path != null,
    models: [],
    efforts: ['low', 'medium', 'high'],
    supportsResume: true,
    supportsTeam: false
  }
  if (!path) return base
  try {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex')
    const cache = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8'))
    const models = (cache.models ?? [])
      .filter((m: { visibility?: string }) => m.visibility !== 'hide')
      .map((m: { slug: string; display_name?: string; supported_reasoning_levels?: { effort: string }[] }) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort)
      }))
    const efforts = [...new Set(models.flatMap((m: { efforts: string[] }) => m.efforts))] as string[]
    return { ...base, models, efforts: efforts.length ? efforts : base.efforts }
  } catch {
    return base // no cache yet: Codex uses its own default model
  }
}

let cached: AgentInfo[] | null = null

export async function detectAgents(refresh = false): Promise<AgentInfo[]> {
  if (cached && !refresh) return cached
  cached = await Promise.all([detectClaudeAgent(), detectCodexAgent()])
  return cached
}

export const agentOf = (tab: Tab): AgentKind => tab.agent ?? 'claude'

/** How to run an agent CLI, or null if it isn't installed. */
export async function agentPath(id: AgentKind): Promise<ResolvedCommand | null> {
  if (id === 'claude') {
    const caps = await detectClaude()
    return caps.helpText ? { file: caps.path, prefix: [] } : null
  }
  return resolveCommand('codex')
}

/**
 * How to run an agent CLI as a plain child process with piped input/output
 * (general chat), rather than inside a terminal. A terminal can launch npm's
 * `.cmd` shim directly; a plain spawn can't, so Claude is resolved the same
 * careful way as Codex (real .exe, or the shim's script run with Node).
 */
export async function agentCommand(id: AgentKind): Promise<ResolvedCommand | null> {
  if (id !== 'claude') return resolveCommand('codex')
  const caps = await detectClaude()
  if (!caps.helpText) return null
  const pinned = process.env.FLEET_CLAUDE_PATH
  if (pinned && existsSync(pinned)) return { file: caps.path, prefix: [] }
  return (await resolveCommand('claude')) ?? { file: caps.path, prefix: [] }
}

/** Commands to sign in / out, and how to install, per agent. */
export const AGENT_AUTH: Record<AgentKind, { login: string[]; logout: string[]; install: string; docs: string }> = {
  claude: {
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    install: 'npm install -g @anthropic-ai/claude-code',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup'
  },
  codex: {
    login: ['login'],
    logout: ['logout'],
    install: 'npm install -g @openai/codex',
    docs: 'https://github.com/openai/codex'
  }
}

/** Installed version + sign-in state, from each CLI's own status command. */
export async function agentStatus(id: AgentKind): Promise<AgentStatus> {
  const { install, docs } = AGENT_AUTH[id]
  return { ...(await rawStatus(id)), install, docs }
}

async function rawStatus(id: AgentKind): Promise<AgentStatus> {
  const cmd = await agentPath(id)
  if (!cmd) return { id, installed: false, loggedIn: false }
  const exec = async (args: string[]): Promise<string> => {
    try {
      const { stdout, stderr } = await run(cmd.file, [...cmd.prefix, ...args], { windowsHide: true, timeout: 15_000 })
      return `${stdout}${stderr}`.trim()
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    }
  }
  const version = (await exec(['--version'])).split(/\r?\n/)[0]
  if (id === 'claude') {
    try {
      const s = JSON.parse(await exec(['auth', 'status', '--json']))
      const how = s.authMethod === 'claude.ai' ? 'Claude account' : s.authMethod
      return {
        id,
        installed: true,
        version,
        loggedIn: !!s.loggedIn,
        account: s.loggedIn ? [s.email, how].filter(Boolean).join(' · ') : undefined
      }
    } catch {
      return { id, installed: true, version, loggedIn: false }
    }
  }
  // Codex prints e.g. "Logged in using ChatGPT" / "Not logged in".
  const out = await exec(['login', 'status'])
  const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out)
  return { id, installed: true, version, loggedIn, account: loggedIn ? out.split(/\r?\n/)[0] : undefined }
}

/** Sign out (non-interactive). */
export async function agentLogout(id: AgentKind): Promise<void> {
  const cmd = await agentPath(id)
  if (!cmd) throw new Error('Agent is not installed.')
  await run(cmd.file, [...cmd.prefix, ...AGENT_AUTH[id].logout], { windowsHide: true, timeout: 15_000 }).catch(() => {})
}

/** Build the spawn command for a tab with whichever agent CLI it uses. */
export async function buildAgentCommand(
  tab: Tab,
  opts: { resume?: boolean; sessionName?: string; appendSystemPrompt?: string; settingsFile?: string }
): Promise<SpawnCommand> {
  if (agentOf(tab) === 'codex') {
    const cmd = await resolveCommand('codex')
    if (!cmd) throw new Error('Codex is not installed. See Settings → Agents.')
    const args: string[] = [...cmd.prefix]
    if (opts.resume) args.push('resume', '--last') // most recent Codex session (per folder)
    if (tab.model) args.push('-m', tab.model)
    // Bare value: not valid TOML, so Codex takes it as a literal string (no quoting to mangle).
    if (tab.effort) args.push('-c', `model_reasoning_effort=${tab.effort}`)
    // Map our interaction modes onto Codex approval policies (sandbox stays on).
    const approval = tab.permissionMode === 'default' ? 'untrusted' : tab.permissionMode === 'acceptEdits' ? 'on-request' : 'never'
    args.push('-a', approval, '-s', 'workspace-write')
    if (!opts.resume && tab.task.trim()) args.push(tab.task.trim())
    return { file: cmd.file, args }
  }
  return buildClaudeCommand({
    projectId: tab.projectId,
    title: tab.title,
    task: tab.task,
    model: tab.model,
    effort: tab.effort,
    permissionMode: tab.permissionMode,
    sessionId: tab.sessionId,
    resume: opts.resume,
    sessionName: opts.sessionName,
    appendSystemPrompt: opts.appendSystemPrompt,
    settingsFile: opts.settingsFile
  })
}
