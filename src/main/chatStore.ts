import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Chat, ChatMessage, CreateChatOptions } from '@shared/types'

/**
 * On-disk storage for general chats. One folder per account (see store.ts
 * chatsDir), holding:
 *   index.json              the chat list (details only, no messages)
 *   <chatId>/messages.json  that chat's messages
 *   <chatId>/images/…       images attached to its messages
 *
 * The agent CLI keeps its own copy of each conversation (that is its memory).
 * This copy is what the app shows, and what gets replayed to the agent if the
 * CLI no longer has the conversation or the chat moves to another agent.
 *
 * No Electron imports here, so the chat engine can be exercised from plain Node.
 */
export class ChatStore {
  private chats: Chat[] | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string) {}

  /** One operation at a time: two replies finishing together must not interleave writes. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<Chat[]> {
    if (!this.chats) {
      const data = await readJson(join(this.dir, 'index.json'))
      this.chats = Array.isArray(data) ? (data as Chat[]).filter((c) => c && typeof c.id === 'string') : []
    }
    return this.chats
  }

  private saveIndex(): Promise<void> {
    return writeJson(join(this.dir, 'index.json'), this.chats ?? [])
  }

  private chatDir(chatId: string): string {
    if (!SAFE_ID.test(chatId)) throw new Error('Invalid chat id.')
    return join(this.dir, chatId)
  }

  /** Newest activity first. */
  list(): Promise<Chat[]> {
    return this.serial(async () => [...(await this.load())].sort((a, b) => b.updatedAt - a.updatedAt))
  }

  get(chatId: string): Promise<Chat | undefined> {
    return this.serial(async () => {
      const c = (await this.load()).find((x) => x.id === chatId)
      return c ? { ...c } : undefined
    })
  }

  create(opts: CreateChatOptions): Promise<Chat> {
    return this.serial(async () => {
      const now = Date.now()
      const chat: Chat = {
        id: randomUUID(),
        title: cleanTitle(opts.title) || 'New chat',
        agent: opts.agent,
        model: opts.model ?? '',
        createdAt: now,
        updatedAt: now
      }
      ;(await this.load()).push(chat)
      await this.saveIndex()
      return { ...chat }
    })
  }

  /** Change a chat's details. A key present with value undefined (e.g. sessionId) is removed. */
  update(chatId: string, patch: Partial<Chat>): Promise<Chat> {
    return this.serial(async () => {
      const chat = (await this.load()).find((x) => x.id === chatId)
      if (!chat) throw new Error('Chat not found.')
      const fields = chat as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || k === 'createdAt') continue
        if (v === undefined) delete fields[k]
        else fields[k] = v
      }
      await this.saveIndex()
      return { ...chat }
    })
  }

  remove(chatId: string): Promise<void> {
    return this.serial(async () => {
      const chats = await this.load()
      this.chats = chats.filter((x) => x.id !== chatId)
      await this.saveIndex()
      await rm(this.chatDir(chatId), { recursive: true, force: true })
    })
  }

  /** A chat's messages, with image paths made absolute. */
  messages(chatId: string): Promise<ChatMessage[]> {
    return this.serial(() => this.readMessages(chatId))
  }

  appendMessage(chatId: string, msg: ChatMessage): Promise<void> {
    return this.serial(async () => {
      await this.writeMessages(chatId, [...(await this.readMessages(chatId)), msg])
    })
  }

  /**
   * Drop everything after the last user message (a failed or stopped reply) and
   * return that user message, so the turn can be run again.
   */
  rewindToLastUserMessage(chatId: string): Promise<ChatMessage | undefined> {
    return this.serial(async () => {
      const all = await this.readMessages(chatId)
      const i = all.map((m) => m.role).lastIndexOf('user')
      if (i < 0) return undefined
      if (i < all.length - 1) await this.writeMessages(chatId, all.slice(0, i + 1))
      return all[i]
    })
  }

  /** Save an attached image (a data URL) into the chat's folder; returns its absolute path. */
  saveImage(chatId: string, dataUrl: string): Promise<string> {
    return this.serial(async () => {
      const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!m) throw new Error('Unsupported image (use PNG, JPEG, GIF or WebP).')
      const dir = join(this.chatDir(chatId), 'images')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
      await writeFile(file, Buffer.from(m[2], 'base64'))
      return file
    })
  }

  /**
   * Move every chat of `from` (another account's folder) into this one. Used
   * when someone who chatted while signed out signs in and brings their data
   * along. Returns the chats that moved.
   */
  adoptAll(from: ChatStore): Promise<Chat[]> {
    if (from.dir === this.dir) return Promise.resolve([])
    return this.serial(() =>
      from.serial(async () => {
        const mine = await this.load()
        const theirs = await from.load()
        const known = new Set(mine.map((c) => c.id))
        const moved: Chat[] = []
        for (const chat of theirs) {
          if (known.has(chat.id) || !SAFE_ID.test(chat.id)) continue
          const src = join(from.dir, chat.id)
          const dest = join(this.dir, chat.id)
          if (existsSync(src)) {
            await mkdir(this.dir, { recursive: true })
            await rename(src, dest).catch(async () => {
              await cp(src, dest, { recursive: true }) // e.g. across drives
              await rm(src, { recursive: true, force: true })
            })
          }
          mine.push(chat)
          moved.push({ ...chat })
        }
        if (moved.length) {
          const gone = new Set(moved.map((c) => c.id))
          from.chats = theirs.filter((c) => !gone.has(c.id))
          await this.saveIndex()
          await from.saveIndex()
        }
        return moved
      })
    )
  }

  // Images are stored by file name (so a chat folder can move); callers see absolute paths.
  private async readMessages(chatId: string): Promise<ChatMessage[]> {
    const dir = this.chatDir(chatId)
    const data = await readJson(join(dir, 'messages.json'))
    if (!Array.isArray(data)) return []
    return (data as ChatMessage[]).map((m) =>
      m.images?.length ? { ...m, images: m.images.map((f) => join(dir, 'images', basename(f))) } : m
    )
  }

  private writeMessages(chatId: string, msgs: ChatMessage[]): Promise<void> {
    const onDisk = msgs.map((m) => (m.images?.length ? { ...m, images: m.images.map((f) => basename(f)) } : m))
    return writeJson(join(this.chatDir(chatId), 'messages.json'), onDisk)
  }
}

// Chat ids are UUIDs; nothing else may become a folder name.
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

/** One line, trimmed, at most 80 characters. */
export function cleanTitle(title: string | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t
}

async function readJson(file: string): Promise<unknown> {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write via a temp file + rename, so a crash mid-write can't leave half a file. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const text = JSON.stringify(data, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch {
    // Rename can fail if something (e.g. antivirus) holds the file: write in place.
    await writeFile(file, text, 'utf8')
    await rm(tmp, { force: true })
  }
}

const stores = new Map<string, ChatStore>()

/** The store for a folder (one instance per folder, so its write queue is shared). */
export function chatStoreAt(dir: string): ChatStore {
  let s = stores.get(dir)
  if (!s) {
    s = new ChatStore(dir)
    stores.set(dir, s)
  }
  return s
}
