import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import type { CreateTabOptions } from '@shared/types'

const run = promisify(execFile)

/**
 * Figures out how to invoke the `claude` CLI on this machine and which flags
 * it supports, then builds the spawn command for a tab.
 *
 * We detect supported flags from `claude --help` at startup instead of
 * hard-coding them, so a future Claude Code release that renames/adds a flag
 * doesn't silently break every tab.
 */
export interface ClaudeCapabilities {
  /** Resolved path to the claude executable. */
  path: string
  supportsModel: boolean
  supportsEffort: boolean
  supportsPermissionMode: boolean
  supportsSessionId: boolean
  supportsResume: boolean
  supportsContinue: boolean
  supportsName: boolean
  supportsAppendSystemPrompt: boolean
  supportsSettings: boolean
  helpText: string
}

let cached: ClaudeCapabilities | null = null

/** Resolve the claude executable path from env, then PATH. */
async function resolveClaudePath(): Promise<string> {
  const fromEnv = process.env.FLEET_CLAUDE_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  // `where` on Windows / `which` on POSIX. Fall back to the bare name and let
  // the OS resolve it at spawn time.
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(locator, ['claude'], { windowsHide: true })
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    // ignore — fall through to bare name
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/** Detect the CLI and its capabilities once, then cache. */
export async function detectClaude(): Promise<ClaudeCapabilities> {
  if (cached) return cached

  const path = await resolveClaudePath()
  let helpText = ''
  try {
    const { stdout } = await run(path, ['--help'], { windowsHide: true, timeout: 15_000 })
    helpText = stdout
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    helpText = (e.stdout || '') + (e.stderr || '')
  }

  cached = {
    path,
    supportsModel: /--model\b/.test(helpText),
    supportsEffort: /--effort\b/.test(helpText),
    supportsPermissionMode: /--permission-mode\b/.test(helpText),
    supportsSessionId: /--session-id\b/.test(helpText),
    supportsResume: /--resume\b/.test(helpText),
    supportsContinue: /--continue\b/.test(helpText),
    supportsName: /--name\b/.test(helpText),
    supportsAppendSystemPrompt: /--append-system-prompt\b/.test(helpText),
    supportsSettings: /--settings\b/.test(helpText),
    helpText
  }
  return cached
}

export interface SpawnCommand {
  file: string
  args: string[]
}

// `isolate` is a worktree concern, irrelevant to the launch command.
export interface BuildOptions extends Omit<CreateTabOptions, 'isolate'> {
  /** Stable Claude session id for this tab (for --session-id / --resume). */
  sessionId: string
  /** When true, re-attach the saved conversation instead of starting fresh. */
  resume?: boolean
  /** Claude session display name — the address teammates message (`--name`). */
  sessionName?: string
  /** Extra system-prompt text (role, teammates, board) via --append-system-prompt. */
  appendSystemPrompt?: string
  /** Extra settings file (our activity hooks) via --settings. */
  settingsFile?: string
}

/**
 * Builds the claude invocation for a tab.
 *
 * Fresh launch: pass the task as a positional prompt (starts the interactive
 * TUI already working on it) and tag it with `--session-id` so it can be
 * resumed later. Resume: re-attach the saved conversation with `--resume`
 * (or `--continue` as a fallback) and DON'T re-send the prompt — the agent
 * picks up its full prior memory.
 */
export async function buildClaudeCommand(opts: BuildOptions): Promise<SpawnCommand> {
  const caps = await detectClaude()
  const args: string[] = []

  if (caps.supportsModel) args.push('--model', opts.model)
  if (caps.supportsEffort) args.push('--effort', opts.effort)
  if (caps.supportsPermissionMode) args.push('--permission-mode', opts.permissionMode)
  if (caps.supportsName && opts.sessionName) args.push('--name', opts.sessionName)
  if (caps.supportsSettings && opts.settingsFile) args.push('--settings', opts.settingsFile)
  if (caps.supportsAppendSystemPrompt && opts.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.appendSystemPrompt)
  }

  if (opts.resume) {
    // Re-attach the existing conversation. Prefer an explicit session id.
    if (caps.supportsResume && caps.supportsSessionId) {
      args.push('--resume', opts.sessionId)
    } else if (caps.supportsContinue) {
      // Each tab has its own worktree (cwd), so --continue resumes the right one.
      args.push('--continue')
    }
    // No positional prompt on resume — keep the saved context intact.
  } else {
    // Fresh session: tag it so we can resume it later.
    if (caps.supportsSessionId) args.push('--session-id', opts.sessionId)
    if (opts.task.trim()) args.push(opts.task.trim())
  }

  return { file: caps.path, args }
}
