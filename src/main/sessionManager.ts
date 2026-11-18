import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { Tab, TabStatus } from '@shared/types'
import { buildAgentCommand } from './agents'

/**
 * Owns the live pseudo-terminal (PTY) process behind every tab.
 *
 * One tab == one `claude` process running inside a PTY, in that tab's git
 * worktree. The PTY makes claude believe it's talking to a real terminal, so
 * colours, the interactive prompt, and the TUI all render correctly. We pipe
 * the PTY's output out as 'data' events (the renderer draws them with xterm.js)
 * and forward the user's keystrokes back in via write().
 */

export interface Session {
  tabId: string
  proc: IPty
  status: TabStatus
}

interface SpawnArgs {
  tab: Tab
  cols: number
  rows: number
  /** Re-attach the saved Claude conversation instead of starting fresh. */
  resume?: boolean
  /** Session name + team prompt (see team.ts). */
  team?: { sessionName: string; prompt: string } | null
}

export declare interface SessionManager {
  on(e: 'data', l: (tabId: string, chunk: string) => void): this
  on(e: 'exit', l: (tabId: string, exitCode: number) => void): this
  on(e: 'status', l: (tabId: string, status: TabStatus) => void): this
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  /** Set on app quit so dying processes don't emit events to a closed window. */
  private shuttingDown = false

  /** Spawn claude for a tab inside its worktree. Returns once the PTY exists. */
  async spawn({ tab, cols, rows, resume, team }: SpawnArgs): Promise<void> {
    if (this.sessions.has(tab.id)) {
      throw new Error(`Session for tab ${tab.id} already running`)
    }

    this.setStatus(tab.id, 'starting')

    const { file, args } = await buildAgentCommand(tab, {
      resume,
      sessionName: team?.sessionName,
      appendSystemPrompt: team?.prompt
    })
    this.spawnCommand(tab.id, file, args, tab.worktreePath, cols, rows)
  }

  /**
   * Run any command in a PTY under `id` (an agent tab, or a utility terminal
   * such as an agent sign-in). Output/exit flow through the same events.
   */
  spawnCommand(id: string, file: string, args: string[], cwd: string, cols = 80, rows = 24): void {
    if (this.sessions.has(id)) throw new Error(`Session ${id} already running`)
    // On Windows node-pty uses ConPTY under the hood.
    const proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      // Inherit env so each CLI reads its shared saved login — one login serves
      // every tab. UTF-8 avoids mojibake in the TUI.
      env: { ...process.env, LANG: 'en_US.UTF-8', FORCE_COLOR: '1' } as Record<string, string>
    })

    const session: Session = { tabId: id, proc, status: 'running' }
    this.sessions.set(id, session)
    this.setStatus(id, 'running')

    proc.onData((chunk) => this.emit('data', id, chunk))

    proc.onExit(({ exitCode }) => {
      // A restart may already have replaced this session; only clean up our own.
      if (this.sessions.get(id)?.proc !== proc) return
      this.sessions.delete(id)
      if (this.shuttingDown) return
      this.setStatus(id, exitCode === 0 ? 'exited' : 'error')
      this.emit('exit', id, exitCode)
    })
  }

  /** Forward user keystrokes (or programmatic input) into the agent. */
  write(tabId: string, data: string): void {
    this.sessions.get(tabId)?.proc.write(data)
  }

  /** Resize the PTY when the terminal panel resizes. */
  resize(tabId: string, cols: number, rows: number): void {
    const s = this.sessions.get(tabId)
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(cols, rows)
      } catch {
        // PTY may have just exited — ignore.
      }
    }
  }

  /** Kill a tab's process (used when the tab is closed). */
  kill(tabId: string): void {
    const s = this.sessions.get(tabId)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      // already gone
    }
    this.sessions.delete(tabId)
  }

  isRunning(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  /** Kill everything — called on app quit. */
  killAll(): void {
    this.shuttingDown = true
    for (const id of this.sessions.keys()) this.kill(id)
  }

  private setStatus(tabId: string, status: TabStatus): void {
    const s = this.sessions.get(tabId)
    if (s) s.status = status
    if (!this.shuttingDown) this.emit('status', tabId, status)
  }
}

export const sessionManager = new SessionManager()
