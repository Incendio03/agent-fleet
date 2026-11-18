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
    helpText
  }
  return cached
}

export interface SpawnCommand {
  file: string
  args: string[]
}

/**
 * Builds the claude invocation for a tab. The task prompt is passed as a
 * positional arg, which starts the interactive TUI already working on it —
 * exactly what we want for a live, watchable terminal tab.
 */
export async function buildClaudeCommand(opts: CreateTabOptions): Promise<SpawnCommand> {
  const caps = await detectClaude()
  const args: string[] = []

  if (caps.supportsModel) args.push('--model', opts.model)
  if (caps.supportsEffort) args.push('--effort', opts.effort)
  if (caps.supportsPermissionMode) args.push('--permission-mode', opts.permissionMode)

  // Seed the session with the task. Keep it last (positional prompt).
  if (opts.task.trim()) args.push(opts.task.trim())

  return { file: caps.path, args }
}
