import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile, stat, open } from 'node:fs/promises'
import type { FleetMessage, Project, Tab } from '@shared/types'
import { store } from './store'

/**
 * "Team" features for agents in the same project:
 *  - Named agents: each tab's Claude session is named `<project>-<role>`, which
 *    is the address other Claude sessions use with SendMessage.
 *  - Team prompt: appended to each agent's system prompt so it knows its role,
 *    its teammates' names, and the shared board.
 *  - Fleet board: <project>/.fleet/board.md, a shared notes file.
 *  - Messages: read from each agent's Claude transcript (SendMessage calls).
 */

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'

/** Session names for every tab in a project, unique within it (`-2`, `-3`… on clashes). */
export function sessionNames(project: Project, tabs: Tab[]): Map<string, string> {
  const base = slug(project.name)
  const used = new Map<string, number>()
  const out = new Map<string, string>()
  const ordered = tabs.filter((t) => t.projectId === project.id).sort((a, b) => a.createdAt - b.createdAt)
  for (const t of ordered) {
    const name = `${base}-${slug(t.title)}`
    const n = (used.get(name) ?? 0) + 1
    used.set(name, n)
    out.set(t.id, n === 1 ? name : `${name}-${n}`)
  }
  return out
}

export const BOARD_REL = '.fleet/board.md'

export function boardPath(project: Project): string {
  return join(project.localPath, '.fleet', 'board.md')
}

/** Create .fleet/board.md (and .fleet/.gitignore) if missing. */
export async function ensureBoard(project: Project): Promise<string> {
  const dir = join(project.localPath, '.fleet')
  await mkdir(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) await writeFile(ignore, '*\n')
  const file = boardPath(project)
  if (!existsSync(file)) {
    await writeFile(
      file,
      `# ${project.name} — Fleet board\n\n` +
        `Shared notes for every agent in this project (and you). Agents read this when\n` +
        `they start and keep their own section up to date.\n\n` +
        `## Goals\n\n- \n\n## Agents\n\n` +
        `<!-- Each agent adds a section: current task, status, handoffs, files it's editing. -->\n`
    )
  }
  return file
}

export interface TeamContext {
  sessionName: string
  prompt: string
}

/** Session name + system-prompt addition for a tab, from the current roster. */
export async function teamContext(tab: Tab): Promise<TeamContext | null> {
  const project = (await store.listProjects()).find((p) => p.id === tab.projectId)
  if (!project) return null
  const tabs = await store.listTabs(project.id)
  const names = sessionNames(project, tabs)
  const sessionName = names.get(tab.id)!
  await ensureBoard(project).catch(() => {})

  const mates = tabs
    .filter((t) => t.id !== tab.id)
    .map((t) => `- ${t.title}: \`${names.get(t.id)}\``)
  const prompt = [
    `# Agent Fleet team`,
    `You are the "${tab.title}" agent in the Agent Fleet project "${project.name}".`,
    `Your session name (your address for other agents) is \`${sessionName}\`.`,
    ``,
    mates.length
      ? `Teammates in this project (session names; only running ones are reachable, and more may join — use ListAgents to see who is live):\n${mates.join('\n')}`
      : `You have no teammates in this project yet. More may join — use ListAgents to see who is live.`,
    ``,
    `To talk to a teammate, use SendMessage with their session name as \`to\`. Messages from`,
    `teammates arrive as <cross-session-message from="...">; reply to the \`from\` name.`,
    `Use messages for handoffs, questions and reviews — not for chatter.`,
    ``,
    `Shared team board: \`${BOARD_REL}\` (in the project folder). Read it when you start`,
    `work. Keep your own section ("## ${tab.title}") current: what you're doing, status,`,
    `handoffs, and which files you're editing. Don't edit files a teammate says they're`,
    `working on — message them instead.`
  ].join('\n')
  return { sessionName, prompt }
}

// ---- Messages (read from Claude transcripts) -------------------------------

/** Claude Code stores transcripts at <config>/projects/<cwd with non-alnum → '-'>/<sessionId>.jsonl */
function transcriptPath(tab: Tab): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects', tab.worktreePath.replace(/[^A-Za-z0-9]/g, '-'), `${tab.sessionId}.jsonl`)
}

interface TailState {
  offset: number
  partial: string
  messages: FleetMessage[]
}
const tails = new Map<string, TailState>() // by transcript path

/** Incrementally read new transcript lines and collect SendMessage calls. */
async function readSent(tab: Tab, fromName: string): Promise<FleetMessage[]> {
  const file = transcriptPath(tab)
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return []
  }
  let st = tails.get(file)
  if (!st || size < st.offset) {
    st = { offset: 0, partial: '', messages: [] }
    tails.set(file, st)
  }
  if (size > st.offset) {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(size - st.offset)
      await fh.read(buf, 0, buf.length, st.offset)
      st.offset = size
      const lines = (st.partial + buf.toString('utf8')).split('\n')
      st.partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('"SendMessage"') || !line.startsWith('{"') || !line.includes('"type":"assistant"')) continue
        try {
          const rec = JSON.parse(line)
          if (rec.type !== 'assistant' || rec.isSidechain) continue
          for (const c of rec.message?.content ?? []) {
            if (c?.type !== 'tool_use' || c.name !== 'SendMessage' || !c.input?.message) continue
            st.messages.push({
              id: c.id,
              ts: Date.parse(rec.timestamp) || 0,
              fromTabId: tab.id,
              from: fromName,
              to: String(c.input.to ?? ''),
              text: String(c.input.message)
            })
          }
        } catch {
          /* skip malformed line */
        }
      }
    } finally {
      await fh.close()
    }
  }
  return st.messages
}

/** All agent-to-agent messages sent by the agents of a project, oldest first. */
export async function projectMessages(projectId: string): Promise<FleetMessage[]> {
  const project = (await store.listProjects()).find((p) => p.id === projectId)
  if (!project) return []
  const tabs = await store.listTabs(projectId)
  const names = sessionNames(project, tabs)
  const all = (await Promise.all(tabs.map((t) => readSent(t, names.get(t.id)!)))).flat()
  return all.sort((a, b) => a.ts - b.ts)
}

/** Session names for a project's tabs, for the UI (tabId -> name). */
export async function projectSessionNames(projectId: string): Promise<Record<string, string>> {
  const project = (await store.listProjects()).find((p) => p.id === projectId)
  if (!project) return {}
  return Object.fromEntries(sessionNames(project, await store.listTabs(projectId)))
}

export async function readBoard(projectId: string): Promise<string> {
  const project = (await store.listProjects()).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found')
  return readFile(await ensureBoard(project), 'utf8')
}

export async function writeBoard(projectId: string, text: string): Promise<void> {
  const project = (await store.listProjects()).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found')
  await writeFile(await ensureBoard(project), text, 'utf8')
}
