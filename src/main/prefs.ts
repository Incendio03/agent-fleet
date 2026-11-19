import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import type { AppPrefs } from '@shared/types'

/**
 * App preferences the main process needs (e.g. at agent launch), stored in
 * <userData>/data/prefs.json. Renderer-only preferences stay in localStorage.
 */
const DEFAULTS: AppPrefs = { classicScrolling: true }

const file = (): string => join(app.getPath('userData'), 'data', 'prefs.json')
let cache: AppPrefs | null = null

export function getPrefs(): AppPrefs {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) } : { ...DEFAULTS }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

export async function setPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
  cache = { ...getPrefs(), ...patch }
  await mkdir(join(app.getPath('userData'), 'data'), { recursive: true })
  await writeFile(file(), JSON.stringify(cache, null, 2))
  return cache
}
