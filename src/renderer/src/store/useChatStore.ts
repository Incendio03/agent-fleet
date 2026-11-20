import { create } from 'zustand'
import type { AgentKind, AgentStatus, Chat, ChatEvent, ChatLive, ChatMessage, SkillInfo } from '@shared/types'
import { getNotifyPrefs, showNotification } from '../lib/notify'

/**
 * State of the general chats (the non-project conversations). Kept apart from
 * useStore so that store stays about projects and agent tabs; useStore tells
 * this one when the account changes (reload) and when a project is selected
 * (select(null)).
 */

/** `activeChatId` while the blank "new chat" screen is showing (no chat saved yet). */
export const NEW_CHAT = 'new'

/** Which agent/model a chat uses. */
export interface ChatChoice {
  agent: AgentKind
  model: string
  /** Skills this chat may use (names of the agent's installed skills). */
  skills?: string[]
}

const CHOICE_KEY = 'fleet.chat.choice'

/** The agent/model picked last time, used for the next new chat. */
export function lastChoice(): ChatChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    return v && (v.agent === 'claude' || v.agent === 'codex') && typeof v.model === 'string' ? v : null
  } catch {
    return null
  }
}

export function rememberChoice(choice: ChatChoice): void {
  // Skills are chosen per chat, so a new chat never inherits them.
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify({ agent: choice.agent, model: choice.model })) } catch { /* ignore */ }
}

const LAST_KEY = 'fleet.chat.last'

/**
 * The chat that was on screen last (an id, or NEW_CHAT), so opening the Chats
 * section again returns to it. Saved chats are remembered across restarts.
 */
let lastOpen: string | null = (() => {
  try { return localStorage.getItem(LAST_KEY) } catch { return null }
})()

function rememberOpen(chatId: string): void {
  lastOpen = chatId
  if (chatId === NEW_CHAT) return
  try { localStorage.setItem(LAST_KEY, chatId) } catch { /* ignore */ }
}

interface ChatState {
  /** False when the running backend has no chat support yet (needs an app restart). */
  available: boolean
  chats: Chat[]
  /** The chat on screen: its id, NEW_CHAT, or null while a project is showing. */
  activeChatId: string | null
  /** Messages per chat, loaded when a chat is first opened. */
  messages: Record<string, ChatMessage[]>
  /** Replies in progress: the text so far and what the agent is doing. */
  live: Record<string, ChatLive>
  /** Chats whose reply finished while you were looking elsewhere. */
  unread: Record<string, boolean>
  /** Sign-in state per agent: chat only offers the ones you've connected. */
  agentStatus: Partial<Record<AgentKind, AgentStatus>>
  /** A problem with the last action, shown above the message box. */
  error: string | null
  /** Installed skills per agent (for the chat's skill picker). */
  skills: Partial<Record<AgentKind, SkillInfo[]>>
  setSkills: (agent: AgentKind, list: SkillInfo[]) => void
  loadSkills: (agent: AgentKind) => Promise<void>

  init: () => void
  /** Load the current account's chats (also after the account changes). */
  reload: () => Promise<void>
  /** Re-check who is signed in (`force`: right now, e.g. after Settings closed). */
  refreshAgents: (ids: AgentKind[], force?: boolean) => Promise<void>
  select: (chatId: string | null) => void
  startNew: () => void
  /** Bring the Chats section on screen: the chat you had open last, else a new chat. */
  open: () => void
  /** Send to the chat on screen; a new chat is created from the first message. */
  send: (text: string, images: string[], choice: ChatChoice) => Promise<boolean>
  retry: (chatId: string) => Promise<void>
  stop: (chatId: string) => void
  rename: (chatId: string, title: string) => Promise<void>
  setChoice: (chatId: string, choice: ChatChoice) => Promise<void>
  remove: (chatId: string) => Promise<void>
  setError: (msg: string | null) => void
}

let subscribed = false
let agentsCheckedAt = 0

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** First line of a message, as the chat's name until a better one is generated. */
function titleFrom(text: string, hasImages: boolean): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (!line) return hasImages ? 'Image' : 'New chat'
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line
}

const byRecent = (chats: Chat[]): Chat[] => [...chats].sort((a, b) => b.updatedAt - a.updatedAt)

export const useChatStore = create<ChatState>((set, get) => ({
  available: typeof window.fleet?.listChats === 'function',
  chats: [],
  activeChatId: null,
  messages: {},
  live: {},
  unread: {},
  agentStatus: {},
  error: null,
  skills: {},

  setSkills: (agent, list) => set((s) => ({ skills: { ...s.skills, [agent]: list } })),

  loadSkills: async (agent) => {
    if (typeof window.fleet.listSkills !== 'function') return
    try {
      const list = await window.fleet.listSkills(agent)
      set((s) => ({ skills: { ...s.skills, [agent]: list } }))
    } catch {
      /* the picker just shows nothing */
    }
  },

  init: () => {
    if (subscribed || !get().available) return
    subscribed = true
    window.fleet.onChatEvent((ev) => onEvent(ev))
    // Coming back to the window counts as reading the chat on screen.
    window.addEventListener('focus', () => {
      const id = get().activeChatId
      if (id && get().unread[id]) set((s) => ({ unread: without(s.unread, id) }))
    })
  },

  reload: async () => {
    if (!get().available) return
    try {
      const [chats, live] = await Promise.all([window.fleet.listChats(), window.fleet.liveChats()])
      const known = new Set(chats.map((c) => c.id))
      set((s) => ({
        chats: byRecent(chats),
        live: Object.fromEntries(Object.entries(live).filter(([id]) => known.has(id))),
        messages: {},
        unread: {},
        error: null,
        activeChatId: s.activeChatId && (s.activeChatId === NEW_CHAT || known.has(s.activeChatId)) ? s.activeChatId : null
      }))
      const open = get().activeChatId
      if (open && open !== NEW_CHAT) void loadMessages(open)
    } catch (e) {
      set({ error: `Could not load chats: ${message(e)}` })
    }
  },

  // Who is signed in? Each check runs the CLIs, so at most every 20 seconds unless forced.
  refreshAgents: async (ids, force = false) => {
    if (!ids.length || !get().available) return
    const have = get().agentStatus
    if (!force && Date.now() - agentsCheckedAt < 20_000 && ids.every((id) => have[id])) return
    agentsCheckedAt = Date.now()
    const all = await Promise.all(ids.map((id) => window.fleet.agentStatus(id).catch(() => null)))
    set((s) => ({
      agentStatus: { ...s.agentStatus, ...Object.fromEntries(all.filter((x): x is AgentStatus => x != null).map((x) => [x.id, x])) }
    }))
  },

  select: (chatId) => {
    if (get().activeChatId === chatId) {
      // Already on screen: clicking it still counts as having seen its reply.
      if (chatId && get().unread[chatId]) set((s) => ({ unread: without(s.unread, chatId) }))
      return
    }
    set((s) => ({ activeChatId: chatId, error: null, unread: chatId ? without(s.unread, chatId) : s.unread }))
    if (chatId) rememberOpen(chatId)
    if (chatId && chatId !== NEW_CHAT && !get().messages[chatId]) void loadMessages(chatId)
  },

  startNew: () => {
    rememberOpen(NEW_CHAT)
    set({ activeChatId: NEW_CHAT, error: null })
  },

  open: () => {
    const s = get()
    if (s.activeChatId !== null) return
    if (lastOpen && lastOpen !== NEW_CHAT && s.chats.some((c) => c.id === lastOpen)) s.select(lastOpen)
    else s.startNew()
  },

  send: async (text, images, choice) => {
    let chatId = get().activeChatId
    set({ error: null })
    try {
      if (!chatId || chatId === NEW_CHAT) {
        const chat = await window.fleet.createChat({ ...choice, title: titleFrom(text, images.length > 0) })
        rememberChoice(choice)
        rememberOpen(chat.id)
        chatId = chat.id
        set((s) => ({ chats: byRecent([chat, ...s.chats]), messages: { ...s.messages, [chat.id]: [] }, activeChatId: chat.id }))
      }
      const id = chatId
      // Show "Thinking…" right away; the backend's own events take over from here.
      set((s) => ({ live: { ...s.live, [id]: s.live[id] ?? { text: '', status: 'Thinking…' } } }))
      const sent = await window.fleet.sendChat(id, text, images)
      set((s) => ({
        // By time, in case the reply's first events beat this call's answer.
        messages: { ...s.messages, [id]: [...(s.messages[id] ?? []).filter((m) => m.id !== sent.id), sent].sort((a, b) => a.ts - b.ts) },
        chats: byRecent(s.chats.map((c) => (c.id === id ? { ...c, updatedAt: sent.ts } : c)))
      }))
      return true
    } catch (e) {
      const id = chatId
      set((s) => ({ error: message(e), live: id ? without(s.live, id) : s.live }))
      return false
    }
  },

  retry: async (chatId) => {
    set({ error: null })
    try {
      await window.fleet.retryChat(chatId)
      set((s) => {
        // The failed/stopped reply is dropped; the question stays.
        const list = s.messages[chatId] ?? []
        const lastUser = list.map((m) => m.role).lastIndexOf('user')
        return {
          messages: { ...s.messages, [chatId]: lastUser >= 0 ? list.slice(0, lastUser + 1) : list },
          live: { ...s.live, [chatId]: s.live[chatId] ?? { text: '', status: 'Thinking…' } }
        }
      })
    } catch (e) {
      set({ error: message(e) })
    }
  },

  stop: (chatId) => {
    void window.fleet.stopChat(chatId).catch(() => undefined)
  },

  rename: async (chatId, title) => {
    try {
      const chat = await window.fleet.updateChat(chatId, { title })
      set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? chat : c)) }))
    } catch (e) {
      set({ error: message(e) })
    }
  },

  setChoice: async (chatId, choice) => {
    try {
      const chat = await window.fleet.updateChat(chatId, choice)
      rememberChoice(choice)
      set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? chat : c)), error: null }))
    } catch (e) {
      set({ error: message(e) })
    }
  },

  remove: async (chatId) => {
    try {
      await window.fleet.deleteChat(chatId)
      if (lastOpen === chatId) lastOpen = NEW_CHAT
      set((s) => ({
        chats: s.chats.filter((c) => c.id !== chatId),
        messages: without(s.messages, chatId),
        live: without(s.live, chatId),
        unread: without(s.unread, chatId),
        activeChatId: s.activeChatId === chatId ? NEW_CHAT : s.activeChatId
      }))
    } catch (e) {
      set({ error: message(e) })
    }
  },

  setError: (msg) => set({ error: msg })
}))

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

async function loadMessages(chatId: string): Promise<void> {
  try {
    const list = await window.fleet.chatMessages(chatId)
    useChatStore.setState((s) => (s.chats.some((c) => c.id === chatId) ? { messages: { ...s.messages, [chatId]: list } } : {}))
  } catch (e) {
    useChatStore.setState({ error: `Could not load this chat: ${message(e)}` })
  }
}

/** Progress of a reply, pushed by the backend. */
function onEvent(ev: ChatEvent): void {
  const { chats, activeChatId } = useChatStore.getState()
  // Not one of the chats on show (another account's, or deleted): ignore.
  if (!chats.some((c) => c.id === ev.chatId)) return
  const id = ev.chatId
  const set = useChatStore.setState

  switch (ev.type) {
    case 'delta':
      set((s) => ({ live: { ...s.live, [id]: { text: (s.live[id]?.text ?? '') + ev.text, status: s.live[id]?.status ?? null } } }))
      break
    case 'text':
      set((s) => ({ live: { ...s.live, [id]: { text: ev.text, status: s.live[id]?.status ?? null } } }))
      break
    case 'status':
      set((s) => ({ live: { ...s.live, [id]: { text: s.live[id]?.text ?? '', status: ev.status } } }))
      break
    case 'chat':
      set((s) => ({ chats: s.chats.map((c) => (c.id === id ? ev.chat : c)) }))
      break
    case 'done': {
      const viewing = activeChatId === id && document.hasFocus()
      set((s) => ({
        live: without(s.live, id),
        chats: byRecent(s.chats.map((c) => (c.id === id ? ev.chat : c))),
        // Only if this chat's messages are loaded; otherwise they load when it's opened.
        messages: s.messages[id]
          ? { ...s.messages, [id]: [...s.messages[id].filter((m) => m.id !== ev.message.id), ev.message].sort((a, b) => a.ts - b.ts) }
          : s.messages,
        unread: viewing ? s.unread : { ...s.unread, [id]: true }
      }))
      if (viewing) break
      const prefs = getNotifyPrefs()
      if (!prefs.enabled || !prefs.done) break
      const body = ev.message.error ?? (ev.message.text.replace(/\s+/g, ' ').slice(0, 140) || 'The reply is ready.')
      showNotification(`${ev.message.error ? 'Chat reply failed' : 'Chat reply ready'} · ${ev.chat.title}`, body, () => {
        useChatStore.getState().select(id)
      })
      break
    }
  }
}
