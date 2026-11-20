import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { AgentKind, Chat, ChatEvent, ChatLive, ChatMessage } from '@shared/types'
import { cleanTitle, type ChatStore } from './chatStore'

/**
 * General chat: an ordinary assistant conversation, answered by whichever agent
 * CLI the user has connected (Claude Code, Codex), run WITHOUT a terminal:
 *
 *  - Claude Code: `claude -p` with stream-json in/out. One process per chat is
 *    kept between messages (so only the first reply pays the ~1s startup); the
 *    reply streams token by token; Stop is a protocol interrupt.
 *  - Codex: `codex exec --json`, one process per message (`exec resume <thread>`
 *    for follow-ups). Its messages arrive whole, not token by token.
 *
 * Both run in a neutral folder with file/terminal tools off (web search stays
 * on), so a chat can't read or change the user's projects. The CLI keeps the
 * conversation's memory under its own session id; if it no longer has it (old
 * sessions are cleaned up), or the chat switches agent, the saved messages are
 * replayed as text in the next prompt.
 *
 * No Electron imports: everything it needs comes in through ChatDeps.
 */

export interface ChatCommand {
  file: string
  prefix: string[]
}

export interface ChatDeps {
  /** How to run an agent CLI, or null when it isn't installed. */
  resolve: (agent: AgentKind) => Promise<ChatCommand | null>
  /** `claude --help` text, to use only flags this Claude Code version has. */
  claudeHelp: () => Promise<string>
  /** Folder the CLIs run in (neutral: no project files). */
  cwd: () => Promise<string>
  /** Push live progress to the UI. */
  emit: (ev: ChatEvent) => void
  /** Model for the cheap "name this chat" call ('' = the agent's default). */
  titleModel?: (agent: AgentKind) => Promise<string>
  /** How long an idle Claude chat process is kept for the next message. */
  idleMs?: number
  /**
   * The skills a chat turned on, ready for its agent: for Claude a plugin
   * folder holding copies of them (loaded with --plugin-dir), for Codex their
   * instructions as text. Missing = chats never use skills.
   */
  chatSkills?: (chat: Chat) => Promise<ChatSkills | null>
  /** A chat is gone: drop whatever chatSkills prepared for it. */
  dropChatSkills?: (chatId: string) => Promise<void>
}

export interface ChatSkills {
  /** Claude: plugin folder with the chosen skills. */
  pluginDir?: string
  /** The skills actually available (installed and turned on). */
  names: string[]
  /** Their instructions as text (Codex, or a Claude without plugin support). */
  instructions?: string
}

const LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }

const CHAT_PROMPT = [
  'You are the assistant in the general chat of Agent Fleet, a desktop app. This is an ordinary conversation, like any general-purpose AI chat: the user may bring any topic, such as questions, writing, analysis, planning, code snippets or everyday things.',
  'Answer directly and conversationally. Match the length to the question: brief for simple ones, thorough when the topic needs it. Ask a clarifying question only when you cannot give a useful answer without it.',
  'The app renders GitHub-flavored Markdown. Use it where it helps reading: fenced code blocks with a language tag, lists, tables, a few headings in a long answer. Short replies are better as plain sentences.',
  'When a question needs current or specific facts, search the web or read the relevant page, and link the pages you relied on.',
  "In this chat you cannot see the user's files, run commands or change anything on their computer. If they want work done inside one of their projects, tell them an agent tab in that project can do it."
].join('\n\n')

const CODEX_PROMPT = `${CHAT_PROMPT}\n\nDo not run shell commands or edit files in this chat, even though you may have tools for it: just converse.`

/** Added to a Claude chat's instructions when it has skills (loaded as the plugin "chat-skills"). */
const skillsNote = (names: string[]): string =>
  `Skills turned on for this chat: ${names.map((n) => `chat-skills:${n}`).join(', ')}. ` +
  "Use the Skill tool to load one of these whenever it applies to the user's request; don't use other skills. " +
  "You can open a skill's own files (the ones its instructions refer to) with the Read tool."


const TITLE_PROMPT =
  'You name chat conversations. Reply with a title for the conversation you are given: 2 to 6 words, in the language the user wrote in. Reply with the title only, with no quotes and no punctuation at the end.'

/** The only tools a Claude chat gets. */
const CLAUDE_TOOLS = 'WebSearch,WebFetch'

/** Characters of earlier conversation carried along when it has to be replayed. */
const MAX_REPLAY = 120_000
/**
 * An idle Claude chat process holds roughly 230 MB, and saves about a second on
 * the next message. So keep few, briefly: the rest simply restart (resuming
 * their conversation) when they're next used.
 */
const MAX_CLAUDE_PROCS = 2
const CLAUDE_IDLE_MS = 5 * 60_000

interface TurnEnd {
  ok: boolean
  error?: string
  /** The CLI no longer has this conversation: retry with the messages replayed. */
  lostSession?: boolean
  /** The CLI rejected an optional setting: retry without the extras. */
  configError?: boolean
}

interface Turn {
  chatId: string
  text: string
  status: string | null
  stopped: boolean
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Ask the CLI to stop this reply (set by whichever CLI is running it). */
  interrupt: () => void
}

type Json = Record<string, any>

export class ChatManager {
  private turns = new Map<string, Turn>()
  private claude = new Map<string, ClaudeProc>()

  constructor(private readonly deps: ChatDeps) {}

  isBusy(chatId: string): boolean {
    return this.turns.has(chatId)
  }

  /** Replies in progress, for a UI that just (re)loaded. */
  live(): Record<string, ChatLive> {
    return Object.fromEntries([...this.turns].map(([id, t]) => [id, { text: t.text, status: t.status }]))
  }

  /**
   * Answer the newest user message of a chat (already saved in `store`).
   * Progress goes out as events; resolves once the reply is saved.
   */
  async reply(store: ChatStore, chatId: string): Promise<void> {
    if (this.turns.has(chatId)) throw new Error('This chat is still replying.')
    // Taken before anything is awaited, so a second send can't slip in beside this one.
    const turn: Turn = { chatId, text: '', status: null, stopped: false, pending: '', flushTimer: null, interrupt: () => {} }
    this.turns.set(chatId, turn)

    let chat: Chat | undefined
    let history: ChatMessage[]
    let user: ChatMessage | undefined
    try {
      chat = await store.get(chatId)
      history = chat ? await store.messages(chatId) : []
      user = history[history.length - 1]
    } catch (err) {
      this.turns.delete(chatId)
      throw err
    }
    if (!chat || !user || user.role !== 'user') {
      this.turns.delete(chatId)
      throw new Error(chat ? 'There is no message to reply to.' : 'Chat not found.')
    }
    this.setStatus(turn, 'Thinking…')

    let end: TurnEnd
    try {
      end = await this.run(store, chat, history, turn)
      if (!end.ok && end.lostSession && !turn.stopped) {
        // The CLI has no such conversation any more: start a new one, replaying ours.
        // (Dropped, not kept in oldSessions: there is nothing left of it to clean up.)
        chat = await store.update(chatId, { sessionId: undefined })
        this.replaceText(turn, '')
        this.setStatus(turn, 'Thinking…')
        end = await this.run(store, chat, history, turn)
      }
    } catch (err) {
      end = { ok: false, error: (err as Error).message }
    }
    this.flush(turn)
    this.turns.delete(chatId)

    const failed = !end.ok && !turn.stopped
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: turn.text.trim(),
      ts: Date.now(),
      agent: chat.agent,
      ...(chat.model ? { model: chat.model } : {}),
      ...(turn.stopped ? { stopped: true } : {}),
      ...(failed ? { error: friendlyError(chat.agent, end.error) } : {})
    }
    let saved: Chat
    try {
      if (!(await store.get(chatId))) return // deleted while replying
      await store.appendMessage(chatId, message)
      saved = await store.update(chatId, { updatedAt: Date.now() })
    } catch {
      return // the chat went away under us; nothing to show
    }
    this.deps.emit({ chatId, type: 'done', message, chat: saved })

    // Name the chat after its first exchange (unless the user already did).
    if (!failed && !turn.stopped && history.length === 1 && !saved.titleLocked && message.text) {
      void this.autoTitle(store, saved, user.text, message.text)
    }
  }

  /** Stop the reply in progress (it is saved as far as it got). */
  stop(chatId: string): void {
    const turn = this.turns.get(chatId)
    if (!turn || turn.stopped) return
    turn.stopped = true
    this.setStatus(turn, 'Stopping…')
    turn.interrupt()
  }

  /** Let go of a chat's CLI process (chat deleted, or its agent/model changed). */
  async forget(chatId: string): Promise<void> {
    this.stop(chatId)
    const proc = this.claude.get(chatId)
    if (proc) {
      this.claude.delete(chatId)
      await proc.close()
    }
  }

  /**
   * A chat is being deleted: stop it, and remove Claude Code's own copy of the
   * conversation too. Claude Code keeps one transcript per session in its
   * config folder (<config>/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl,
   * plus an <id>/ folder for extras); leaving it would keep the deleted chat's
   * full text on disk. Codex's history is left alone: it is indexed by Codex's
   * own database, which we must not edit behind its back.
   */
  async discard(chat: Chat): Promise<void> {
    await this.forget(chat.id)
    await this.deps.dropChatSkills?.(chat.id).catch(() => undefined)
    const ids = [...(chat.oldSessions ?? []), ...(chat.agent === 'claude' && chat.sessionId ? [chat.sessionId] : [])]
    if (!ids.length) return
    const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const dir = join(config, 'projects', (await this.deps.cwd()).replace(/[^A-Za-z0-9]/g, '-'))
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue // session ids are UUIDs; never build a path from anything else
      await rm(join(dir, `${id}.jsonl`), { force: true }).catch(() => undefined)
      await rm(join(dir, id), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Stop everything (app quitting, or another account's chats are about to show). */
  async shutdown(): Promise<void> {
    for (const id of [...this.turns.keys()]) this.stop(id)
    const procs = [...this.claude.values()]
    this.claude.clear()
    await Promise.all(procs.map((p) => p.close(true)))
  }

  // ---- progress helpers -----------------------------------------------------

  private setStatus(turn: Turn, status: string | null): void {
    if (turn.status === status) return
    turn.status = status
    this.deps.emit({ chatId: turn.chatId, type: 'status', status })
  }

  /** More reply text. Batched (~25 updates/s) so the UI isn't flooded token by token. */
  private addText(turn: Turn, text: string): void {
    if (!text) return
    turn.text += text
    turn.pending += text
    if (turn.status && !turn.stopped) this.setStatus(turn, null)
    turn.flushTimer ??= setTimeout(() => this.flush(turn), 40)
  }

  private flush(turn: Turn): void {
    if (turn.flushTimer) clearTimeout(turn.flushTimer)
    turn.flushTimer = null
    if (!turn.pending) return
    this.deps.emit({ chatId: turn.chatId, type: 'delta', text: turn.pending })
    turn.pending = ''
  }

  /** The whole reply so far (for CLIs that deliver complete messages). */
  private replaceText(turn: Turn, text: string): void {
    if (turn.flushTimer) clearTimeout(turn.flushTimer)
    turn.flushTimer = null
    turn.pending = ''
    if (turn.text === text) return
    turn.text = text
    if (text && turn.status && !turn.stopped) this.setStatus(turn, null)
    this.deps.emit({ chatId: turn.chatId, type: 'text', text })
  }

  /** Start a new paragraph before another block of reply text. */
  private paragraph(turn: Turn): void {
    if (turn.text && !turn.text.endsWith('\n\n')) this.addText(turn, turn.text.endsWith('\n') ? '\n' : '\n\n')
  }

  // ---- one attempt ----------------------------------------------------------

  private run(store: ChatStore, chat: Chat, history: ChatMessage[], turn: Turn): Promise<TurnEnd> {
    const user = history[history.length - 1]
    // No CLI conversation yet but earlier messages exist (other agent before,
    // or the CLI lost it): carry them along as text.
    const earlier = chat.sessionId ? [] : history.slice(0, -1)
    const images = user.images ?? []
    // A message can be just an image; both CLIs still need some prompt text.
    const said = user.text || `Please look at the attached image${images.length === 1 ? '' : 's'}.`
    const text = earlier.length ? withHistory(earlier, said) : said
    return chat.agent === 'codex'
      ? this.runCodex(store, chat, text, images, turn)
      : this.runClaude(store, chat, text, images, turn)
  }

  // ---- Claude Code ----------------------------------------------------------

  private async runClaude(store: ChatStore, chat: Chat, text: string, images: string[], turn: Turn): Promise<TurnEnd> {
    const content: Json[] = []
    for (const file of images) {
      const type = IMAGE_TYPES[extname(file).toLowerCase()]
      if (!type) continue
      content.push({ type: 'image', source: { type: 'base64', media_type: type, data: (await readFile(file)).toString('base64') } })
    }
    content.push({ type: 'text', text })

    const proc = await this.claudeFor(store, chat)
    const end: TurnEnd = turn.stopped
      ? { ok: true } // stopped while it was starting up
      : await proc.ask(content, turn, {
          addText: (t) => this.addText(turn, t),
          paragraph: () => this.paragraph(turn),
          status: (s) => { if (!turn.stopped) this.setStatus(turn, s) }
        })
    if (proc.exited) {
      if (this.claude.get(chat.id) === proc) this.claude.delete(chat.id)
    } else {
      // Keep it for the next message, but not forever.
      proc.idleAfter(this.deps.idleMs ?? CLAUDE_IDLE_MS, () => {
        if (this.claude.get(chat.id) === proc) this.claude.delete(chat.id)
        void proc.close()
      })
    }
    return end
  }

  /** The chat's Claude process: the one kept from its last message, or a new one. */
  private async claudeFor(store: ChatStore, chat: Chat): Promise<ClaudeProc> {
    // What the process was started with: a different model or skill set needs a new one.
    const wanted = [...(chat.skills ?? [])].sort()
    const key = `${chat.model}|${wanted.join(',')}`
    const kept = this.claude.get(chat.id)
    // Reusable only if it holds this very conversation with this model.
    if (kept && !kept.exited && kept.key === key && kept.sessionId === chat.sessionId) {
      kept.touch()
      return kept
    }
    if (kept) {
      // Model changed, it died, or its conversation is gone: the old process
      // must have exited before a conversation is opened for this chat again.
      this.claude.delete(chat.id)
      await kept.close()
    }

    const cmd = await this.deps.resolve('claude')
    if (!cmd) throw new Error('Claude Code is not installed. See Settings → Agents.')
    const resume = Boolean(chat.sessionId)
    const sessionId = chat.sessionId ?? randomUUID()
    const skills = wanted.length && this.deps.chatSkills ? await this.deps.chatSkills(chat) : null
    const args = claudeArgs(await this.deps.claudeHelp(), { model: chat.model, sessionId, resume, skills })
    const child = spawn(cmd.file, [...cmd.prefix, ...args], {
      cwd: await this.deps.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const proc = new ClaudeProc(child, key, sessionId, () => {
      // The CLI has started the conversation under this id: remember it.
      if (!resume) void store.update(chat.id, { sessionId }).catch(() => undefined)
    })
    this.claude.set(chat.id, proc)

    // Don't let idle chat processes pile up: close the least recently used.
    const idle = [...this.claude.entries()].filter(([, p]) => !p.busy).sort((a, b) => a[1].usedAt - b[1].usedAt)
    while (this.claude.size > MAX_CLAUDE_PROCS && idle.length) {
      const [id, p] = idle.shift()!
      if (p === proc) continue
      this.claude.delete(id)
      void p.close()
    }
    return proc
  }

  // ---- Codex ----------------------------------------------------------------

  private async runCodex(store: ChatStore, chat: Chat, text: string, images: string[], turn: Turn): Promise<TurnEnd> {
    const first = await this.codexOnce(store, chat, text, images, turn, true)
    // An optional setting this Codex version doesn't know: go without the extras.
    if (!first.ok && first.configError && !turn.stopped) return this.codexOnce(store, chat, text, images, turn, false)
    return first
  }

  private async codexOnce(
    store: ChatStore,
    chat: Chat,
    text: string,
    images: string[],
    turn: Turn,
    extras: boolean
  ): Promise<TurnEnd> {
    const cmd = await this.deps.resolve('codex')
    if (!cmd) throw new Error('Codex is not installed. See Settings → Agents.')
    const cwd = await this.deps.cwd()
    // Codex can't load just some skills for one chat, so the chosen ones come along as instructions.
    const skills = chat.skills?.length && this.deps.chatSkills ? await this.deps.chatSkills(chat) : null
    const prompt = skills?.instructions ? `${CODEX_PROMPT}\n\n${skills.instructions}` : CODEX_PROMPT
    const args = [...cmd.prefix, ...codexArgs({ model: chat.model, sessionId: chat.sessionId, images, cwd, extras, prompt })]
    if (turn.stopped) return { ok: true }
    const child = spawn(cmd.file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    return new Promise<TurnEnd>((resolve) => {
      let settled = false
      const finish = (end: TurnEnd): void => {
        if (settled) return
        settled = true
        resolve(end)
      }
      const messages = new Map<string, string>() // agent_message item id -> text
      let lastError = ''
      let stderr = ''
      turn.interrupt = () => killTree(child)

      readLines(child.stdout, (line) => {
        let ev: Json
        try { ev = JSON.parse(line) } catch { return }
        switch (ev.type) {
          case 'thread.started':
            // Codex names the conversation; keep the id so follow-ups resume it.
            if (typeof ev.thread_id === 'string' && ev.thread_id !== chat.sessionId) {
              void store.update(chat.id, { sessionId: ev.thread_id }).catch(() => undefined)
            }
            break
          case 'turn.started':
            if (!turn.stopped) this.setStatus(turn, 'Thinking…')
            break
          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            const item: Json = ev.item ?? {}
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              messages.set(String(item.id ?? messages.size), item.text)
              this.replaceText(turn, [...messages.values()].filter(Boolean).join('\n\n'))
            } else if (!turn.stopped && ev.type !== 'item.completed') {
              const status = codexStatus(item)
              if (status) this.setStatus(turn, status)
            } else if (!turn.stopped && item.type !== 'agent_message') {
              this.setStatus(turn, 'Thinking…')
            }
            break
          }
          case 'error':
            if (/^Reconnecting/i.test(String(ev.message ?? ''))) {
              if (!turn.stopped) this.setStatus(turn, 'Reconnecting…')
            } else {
              lastError = String(ev.message ?? '')
            }
            break
          case 'turn.failed':
            lastError = String(ev.error?.message ?? lastError)
            finish({ ok: false, error: lastError || 'Codex could not finish the reply.' })
            break
          case 'turn.completed':
            finish({ ok: true })
            break
        }
      })
      child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-4000) })
      child.on('error', (err) => finish({ ok: false, error: `Could not start Codex: ${err.message}` }))
      child.on('close', (code) => {
        if (turn.stopped) return finish({ ok: true })
        const err = stripAnsi(stderr)
        if (/no rollout found|thread\/resume failed|conversation not found|session not found/i.test(err)) {
          return finish({ ok: false, lostSession: true, error: lastLine(err) })
        }
        if (extras && /Error loading config|error: (unexpected argument|invalid value)/i.test(err)) {
          return finish({ ok: false, configError: true, error: lastLine(err) })
        }
        finish(code === 0 && turn.text ? { ok: true } : { ok: false, error: lastError || lastLine(err) || `Codex stopped unexpectedly (exit code ${code}).` })
      })
      child.stdin.on('error', () => undefined) // it may exit before reading the prompt
      child.stdin.end(text)
    })
  }

  // ---- chat titles ----------------------------------------------------------

  /**
   * Replace the first-message title with a short generated one (best effort).
   * Claude only for now: it is one small, fast call there. Codex chats keep the
   * title taken from their first message.
   */
  private async autoTitle(store: ChatStore, chat: Chat, userText: string, replyText: string): Promise<void> {
    if (chat.agent !== 'claude') return
    try {
      const sample = `User: ${userText.slice(0, 1500)}\n\nAssistant: ${replyText.slice(0, 1500)}`
      const raw = await this.claudeOneShot(TITLE_PROMPT, `${sample}\n\nTitle:`)
      const title = cleanTitle(raw.split(/\r?\n/).find((l) => l.trim())?.replace(/^[\s"'“”‘’`*#]+|[\s"'“”‘’`*.:]+$/g, ''))
      if (!title) return
      const now = await store.get(chat.id)
      if (!now || now.titleLocked) return
      this.deps.emit({ chatId: chat.id, type: 'chat', chat: await store.update(chat.id, { title }) })
    } catch {
      /* the title from the first message stays */
    }
  }

  /** A single question to Claude with no tools and nothing saved; returns its text answer. */
  private async claudeOneShot(system: string, input: string, timeoutMs = 45_000): Promise<string> {
    const cmd = await this.deps.resolve('claude')
    if (!cmd) throw new Error('not installed')
    const help = await this.deps.claudeHelp()
    const model = (await this.deps.titleModel?.('claude')) ?? ''
    const args = ['-p', '--output-format', 'json']
    // Without this the title call would leave a session behind for every chat.
    if (!hasFlag(help, '--no-session-persistence') || !hasFlag(help, '--tools')) throw new Error('unsupported')
    args.push('--no-session-persistence', '--tools', '')
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--safe-mode']) if (hasFlag(help, f)) args.push(f)
    args.push(hasFlag(help, '--system-prompt') ? '--system-prompt' : '--append-system-prompt', system)
    if (model && hasFlag(help, '--model')) args.push('--model', model)

    const child = spawn(cmd.file, [...cmd.prefix, ...args], {
      cwd: await this.deps.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      const timer = setTimeout(() => { killTree(child); reject(new Error('timed out')) }, timeoutMs)
      timer.unref?.()
      child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
      child.stderr.resume()
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', () => { clearTimeout(timer); resolve(stdout) })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    })
    const res = JSON.parse(out) as Json
    if (res.is_error || typeof res.result !== 'string') throw new Error('no title')
    return res.result
  }
}

// ---- Claude Code process ------------------------------------------------------

interface TurnSink {
  addText: (text: string) => void
  paragraph: () => void
  status: (status: string | null) => void
}

/** One `claude -p` process speaking stream-json, serving one chat's turns in sequence. */
class ClaudeProc {
  exited = false
  usedAt = Date.now()
  private stderr = ''
  private sink: TurnSink | null = null
  private settle: ((end: TurnEnd) => void) | null = null
  private turn: Turn | null = null
  /** API message ids whose text already arrived as stream deltas. */
  private streamed = new Set<string>()
  private apiError = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private announced = false
  private readonly closed: Promise<void>

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    /** What it was started with (the model): a different value needs a new process. */
    readonly key: string,
    readonly sessionId: string,
    private readonly onSession: () => void
  ) {
    readLines(child.stdout, (line) => {
      let ev: Json
      try { ev = JSON.parse(line) } catch { return }
      this.onEvent(ev)
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-4000) })
    child.stdin.on('error', () => undefined) // writes after it died surface through 'close'
    this.closed = new Promise((resolve) => {
      const gone = (why?: string): void => {
        if (this.exited) return
        this.exited = true
        this.clearIdle()
        resolve()
        this.finish(
          this.turn?.stopped
            ? { ok: true }
            : { ok: false, ...this.failure(why || lastLine(stripAnsi(this.stderr)) || 'Claude stopped unexpectedly.') }
        )
      }
      child.on('error', (err) => gone(`Could not start Claude: ${err.message}`))
      child.on('close', () => gone())
    })
  }

  get busy(): boolean {
    return this.settle !== null
  }

  touch(): void {
    this.usedAt = Date.now()
    this.clearIdle()
  }

  /** Send one user message; resolves when its reply (the turn) is over. */
  ask(content: Json[], turn: Turn, sink: TurnSink): Promise<TurnEnd> {
    this.touch()
    if (this.exited) return Promise.resolve({ ok: false, error: 'Claude stopped unexpectedly.' })
    return new Promise<TurnEnd>((resolve) => {
      this.sink = sink
      this.settle = resolve
      this.turn = turn
      this.apiError = ''
      this.streamed.clear()
      let killTimer: ReturnType<typeof setTimeout> | null = null
      turn.interrupt = () => {
        this.write({ type: 'control_request', request_id: `stop-${randomUUID()}`, request: { subtype: 'interrupt' } })
        // If it doesn't wind the turn down promptly, end the process instead.
        killTimer = setTimeout(() => { if (this.turn === turn) killTree(this.child) }, 5000)
        killTimer.unref?.()
      }
      const done = this.settle
      this.settle = (end) => {
        if (killTimer) clearTimeout(killTimer)
        done(end)
      }
      this.write({ type: 'user', message: { role: 'user', content } })
    })
  }

  /** Close it after `ms` without another message. */
  idleAfter(ms: number, onIdle: () => void): void {
    this.clearIdle()
    this.idleTimer = setTimeout(onIdle, ms)
    this.idleTimer.unref?.()
  }

  /** End the process (politely by closing its input; forcefully if it lingers or `now`). */
  async close(now = false): Promise<void> {
    this.clearIdle()
    if (this.exited) return
    if (now) killTree(this.child)
    else {
      try { this.child.stdin.end() } catch { /* already closed */ }
      const t = setTimeout(() => killTree(this.child), 3000)
      t.unref?.()
      void this.closed.then(() => clearTimeout(t))
    }
    await this.closed
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private write(obj: Json): void {
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`) } catch { /* surfaces through 'close' */ }
  }

  private finish(end: TurnEnd): void {
    const settle = this.settle
    this.settle = null
    this.sink = null
    this.turn = null
    this.usedAt = Date.now()
    settle?.(end)
  }

  private failure(message: string): Pick<TurnEnd, 'error' | 'lostSession'> {
    return { error: message, lostSession: /No conversation found/i.test(message) }
  }

  private onEvent(ev: Json): void {
    const sink = this.sink
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && !this.announced) {
          this.announced = true
          this.onSession()
        } else if (ev.subtype === 'thinking_tokens') {
          sink?.status('Thinking…')
        } else if (ev.subtype === 'status' && ev.status === 'compacting') {
          sink?.status('Summarizing the conversation so far…')
        }
        break

      case 'stream_event': {
        const e: Json = ev.event ?? {}
        if (ev.parent_tool_use_id) break
        if (e.type === 'message_start' && e.message?.id) {
          this.streamed.add(e.message.id)
        } else if (e.type === 'content_block_start') {
          const block: Json = e.content_block ?? {}
          if (block.type === 'text') sink?.paragraph()
          else if (block.type === 'thinking') sink?.status('Thinking…')
          else if (block.type === 'tool_use') sink?.status(toolStatus(block.name, block.input))
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          sink?.addText(String(e.delta.text ?? ''))
        }
        break
      }

      case 'assistant': {
        if (ev.parent_tool_use_id) break
        const msg: Json = ev.message ?? {}
        const blocks: Json[] = Array.isArray(msg.content) ? msg.content : []
        if (ev.is_api_error_message || ev.error) {
          // Not a reply: the CLI's wording of an API failure (bad model, limits, sign-in…).
          this.apiError = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim() || String(ev.error)
          break
        }
        for (const b of blocks) {
          if (b.type === 'tool_use') sink?.status(toolStatus(b.name, b.input))
          else if (b.type === 'text' && !this.streamed.has(msg.id) && b.text) {
            // Text that wasn't streamed (older CLIs, or no partial messages).
            sink?.paragraph()
            sink?.addText(String(b.text))
          }
        }
        break
      }

      case 'user':
        // A tool result came back: the model is working on its answer again.
        if (!ev.parent_tool_use_id && Array.isArray(ev.message?.content) && ev.message.content.some((b: Json) => b.type === 'tool_result')) {
          sink?.status('Thinking…')
        }
        break

      case 'result': {
        const turn = this.turn
        const aborted = Boolean(turn?.stopped) || /^aborted/.test(String(ev.terminal_reason ?? ''))
        if (ev.is_error && !aborted) {
          const text = [this.apiError, ev.result, ...(Array.isArray(ev.errors) ? ev.errors : [])]
            .find((s) => typeof s === 'string' && s.trim() && !/^\[ede_diagnostic\]/.test(s))
          this.finish({ ok: false, ...this.failure(String(text ?? 'Claude could not finish the reply.')) })
        } else {
          if (!aborted && turn && !turn.text.trim() && typeof ev.result === 'string') sink?.addText(ev.result)
          this.finish({ ok: true })
        }
        break
      }
    }
  }
}

// ---- helpers -------------------------------------------------------------------

/** Is `--flag` listed in a CLI's help text? (Not fooled by longer flags sharing the prefix.) */
export function hasFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?![\\w-])`, 'm').test(help)
}

/** The `claude` invocation for a chat process (only flags this version supports). */
export function claudeArgs(
  help: string,
  o: { model: string; sessionId: string; resume: boolean; skills?: ChatSkills | null }
): string[] {
  if (!hasFlag(help, '--input-format') || !/stream-json/.test(help) || !hasFlag(help, '--tools')) {
    throw new Error('This version of Claude Code is too old for chat. Update Claude Code, then try again.')
  }
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (hasFlag(help, '--include-partial-messages')) args.push('--include-partial-messages')
  let prompt = CHAT_PROMPT
  const pluginDir = o.skills?.pluginDir
  const plugin = Boolean(pluginDir && o.skills?.names.length) && ['--plugin-dir', '--setting-sources', '--restricted', '--add-dir'].every((f) => hasFlag(help, f))
  if (plugin && pluginDir && o.skills) {
    // Skills on: load ONLY the chat's own plugin. --setting-sources "" keeps the
    // user's settings, hooks and installed plugins out (what --safe-mode does,
    // but safe mode would also drop our plugin); --restricted confines the Read
    // tool to the working folder plus the plugin, so a skill can open its own
    // files and nothing else.
    const tools = `${CLAUDE_TOOLS},Skill,Read`
    args.push('--tools', tools)
    if (hasFlag(help, '--allowedTools')) args.push('--allowedTools', tools)
    args.push('--setting-sources', '', '--restricted', '--plugin-dir', pluginDir, '--add-dir', pluginDir)
    if (hasFlag(help, '--strict-mcp-config')) args.push('--strict-mcp-config')
    prompt = `${CHAT_PROMPT}\n\n${skillsNote(o.skills.names)}`
  } else {
    // Web tools only: no file, shell or MCP tools, and no project customizations.
    args.push('--tools', CLAUDE_TOOLS)
    if (hasFlag(help, '--allowedTools')) args.push('--allowedTools', CLAUDE_TOOLS)
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--safe-mode']) if (hasFlag(help, f)) args.push(f)
    if (o.skills?.instructions) prompt = `${CHAT_PROMPT}\n\n${o.skills.instructions}`
  }
  if (hasFlag(help, '--permission-prompts')) args.push('--permission-prompts', 'none')
  // Use the instructions given now, not ones recorded earlier in the conversation:
  // turning skills on or off for a chat changes them.
  if (hasFlag(help, '--system-prompt-snapshot')) args.push('--system-prompt-snapshot', 'off')
  if (hasFlag(help, '--system-prompt')) args.push('--system-prompt', prompt)
  else if (hasFlag(help, '--append-system-prompt')) args.push('--append-system-prompt', prompt)
  if (o.model && hasFlag(help, '--model')) args.push('--model', o.model)
  args.push(o.resume ? '--resume' : '--session-id', o.sessionId)
  return args
}

/** The `codex exec` invocation for one chat message (the prompt itself goes to stdin). */
export function codexArgs(o: {
  model: string
  sessionId?: string
  images: string[]
  cwd: string
  /** Optional settings (instructions, live web search); dropped if this Codex rejects them. */
  extras: boolean
  prompt: string
}): string[] {
  // Each image gets its own -i so the option can't swallow what follows.
  const images = o.images.flatMap((p) => ['-i', p])
  const common = ['--json', '--skip-git-repo-check']
  if (o.model) common.push('-m', o.model)
  if (o.extras) common.push('-c', `developer_instructions=${JSON.stringify(o.prompt)}`, '-c', 'web_search="live"')
  // Read-only sandbox: a chat must not change files. (`exec resume` has no -s/-C flags.)
  return o.sessionId
    ? ['exec', 'resume', ...images, ...common, '-c', 'sandbox_mode="read-only"', o.sessionId, '-']
    : ['exec', ...images, ...common, '-s', 'read-only', '-C', o.cwd, '-']
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** "Searching the web…" style line for a Claude tool call. */
function toolStatus(name: unknown, input: Json | undefined): string {
  if (name === 'WebSearch') return input?.query ? `Searching the web: ${clip(String(input.query), 80)}` : 'Searching the web…'
  if (name === 'WebFetch') return input?.url ? `Reading ${hostOf(String(input.url))}` : 'Reading a web page…'
  return 'Working…'
}

function codexStatus(item: Json): string | null {
  switch (item.type) {
    case 'reasoning': return 'Thinking…'
    case 'web_search': return item.query ? `Searching the web: ${clip(String(item.query), 80)}` : 'Searching the web…'
    case 'command_execution': return 'Running a command…'
    case 'mcp_tool_call': return 'Using a tool…'
    default: return null
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return clip(url, 60) }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return clip(lines[lines.length - 1] ?? '', 600)
}

/** What to show when a reply failed: sign-in problems get a pointer to Settings. */
function friendlyError(agent: AgentKind, raw: string | undefined): string {
  const msg = clip(stripAnsi(raw ?? '').trim() || 'Something went wrong.', 600)
  if (/\b401\b|unauthori[sz]ed|not logged in|please run \/login|invalid api key|authentication_error|oauth token/i.test(msg)) {
    return `${LABEL[agent]} isn't signed in. Open Settings → Agents to sign in, then try again.`
  }
  // The CLI's advice is for its own terminal UI; point at the chat's model picker instead.
  return msg.replace(/\s*Run --model to pick a different model\.?/i, ' Pick a different model below the message box.')
}

/** The earlier conversation as text, in front of the new message. */
function withHistory(earlier: ChatMessage[], text: string): string {
  const lines: string[] = []
  for (const m of earlier) {
    const body = m.text.trim()
    const images = m.images?.length ? `[${m.images.length} image${m.images.length === 1 ? '' : 's'} attached] ` : ''
    if (m.role === 'user') lines.push(`User: ${images}${body}`)
    else if (body) lines.push(`Assistant: ${body}${m.stopped ? ' [reply was cut short]' : ''}`)
  }
  let transcript = lines.join('\n\n')
  if (transcript.length > MAX_REPLAY) transcript = `[earlier messages left out]\n\n${transcript.slice(-MAX_REPLAY)}`
  return [
    'This conversation began earlier. Its messages so far are below so that you have the context; continue it naturally and do not mention this note.',
    `<conversation_so_far>\n${transcript}\n</conversation_so_far>`,
    `The user's new message:\n\n${text}`
  ].join('\n\n')
}

/** Call `onLine` for each complete line of a stream (UTF-8). */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buf.trim()) onLine(buf.trim())
    buf = ''
  })
}

/** End a process and everything it started (Codex's launcher starts the real binary as a child). */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid == null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  } else {
    child.kill('SIGTERM')
  }
}
