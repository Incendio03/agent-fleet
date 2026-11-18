import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { TabActivity } from '@shared/types'
import { HOOK_PORT } from './authServer'

/**
 * "Needs you" alerts. Each Claude agent is launched with hooks (via
 * `--settings <file>`) that POST to the app's loopback server when it starts
 * working, finishes its turn, or needs attention (permission / waiting for
 * input). The URL carries a random per-run token so only our agents count.
 */

const TOKEN = randomBytes(12).toString('hex')

/** Hook event name in the URL -> what it means for the tab. */
const EVENTS: Record<string, TabActivity['kind']> = {
  prompt: 'working', // UserPromptSubmit
  stop: 'done', // Stop: finished its turn
  notify: 'input' // Notification: needs permission / waiting for input
}

/** Write the per-tab hooks settings file and return its path (for --settings). */
export async function hookSettingsFile(tabId: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'hooks')
  await mkdir(dir, { recursive: true })
  const url = (event: string): string => `http://127.0.0.1:${HOOK_PORT}/hook/${TOKEN}/${tabId}/${event}`
  // curl ships with Windows 10+ (and Git Bash); stdin carries the hook's JSON payload.
  const cmd = (event: string): string => `curl -s -m 2 -X POST --data-binary @- ${url(event)}`
  const hook = (event: string): unknown[] => [{ hooks: [{ type: 'command', command: cmd(event) }] }]
  const file = join(dir, `${tabId}.json`)
  await writeFile(
    file,
    JSON.stringify({ hooks: { UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify') } }, null, 2)
  )
  return file
}

/** Parse a hook request (`/hook/<token>/<tabId>/<event>`) into an activity, or null. */
export function parseHook(path: string, body: string): TabActivity | null {
  const m = /^\/hook\/([a-f0-9]+)\/([A-Za-z0-9-]+)\/([a-z]+)$/.exec(path)
  if (!m || m[1] !== TOKEN) return null
  const kind = EVENTS[m[3]]
  if (!kind) return null
  let message: string | undefined
  try {
    const payload = JSON.parse(body) as { message?: string }
    if (typeof payload.message === 'string') message = payload.message
  } catch {
    /* payload is optional */
  }
  return { tabId: m[2], kind, message }
}
