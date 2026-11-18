/** Desktop-notification preferences + the notification itself ("needs you" alerts). */

export interface NotifyPrefs {
  /** Show Windows notifications at all. */
  enabled: boolean
  /** When an agent finishes its turn. */
  done: boolean
  /** When an agent needs you (permission prompt / waiting for input). */
  input: boolean
}

const KEY = 'fleet.notify'
const DEFAULTS: NotifyPrefs = { enabled: true, done: true, input: true }

export function getNotifyPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<NotifyPrefs>) }
  } catch {
    return DEFAULTS
  }
}

export function setNotifyPrefs(p: NotifyPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

/** Show a Windows notification; clicking it brings the app forward and calls onClick. */
export function showNotification(title: string, body: string, onClick: () => void): void {
  try {
    const n = new Notification(title, { body, silent: false })
    n.onclick = () => {
      window.fleet.focusWindow()
      onClick()
      n.close()
    }
  } catch {
    /* notifications unavailable — the in-app badges still show */
  }
}
