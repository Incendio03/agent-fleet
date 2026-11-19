import { useState } from 'react'
import { getNotifyPrefs, setNotifyPrefs, showNotification, type NotifyPrefs } from '../lib/notify'

/** Settings → Notifications: when agents should alert you. */
export function NotificationSettings(): JSX.Element {
  const [prefs, setPrefs] = useState<NotifyPrefs>(getNotifyPrefs)

  const update = (patch: Partial<NotifyPrefs>): void => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    setNotifyPrefs(next)
  }

  return (
    <div className="settings-section">
      <h3 style={{ margin: 0, fontSize: 15 }}>Notifications</h3>
      <p className="modal-sub">
        Agents always show a badge on their tab and project when they need you. Windows
        notifications are for when you're looking at another tab or another app.
      </p>

      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        <div>
          <div className="settings-toggle-title">Windows notifications</div>
          <div className="settings-toggle-hint">Pop-up + taskbar flash. Click one to jump to the agent.</div>
        </div>
      </label>
      <label className={`settings-toggle ${prefs.enabled ? '' : 'disabled'}`}>
        <input type="checkbox" disabled={!prefs.enabled} checked={prefs.input} onChange={(e) => update({ input: e.target.checked })} />
        <div>
          <div className="settings-toggle-title">When an agent needs you</div>
          <div className="settings-toggle-hint">A permission prompt, or it's waiting for your input.</div>
        </div>
      </label>
      <label className={`settings-toggle ${prefs.enabled ? '' : 'disabled'}`}>
        <input type="checkbox" disabled={!prefs.enabled} checked={prefs.done} onChange={(e) => update({ done: e.target.checked })} />
        <div>
          <div className="settings-toggle-title">When an agent finishes</div>
          <div className="settings-toggle-hint">It finished its turn and is ready for your next message. Also when a chat reply is ready.</div>
        </div>
      </label>

      <button
        className="btn sm"
        style={{ marginTop: 14 }}
        onClick={() => showNotification('Agent Fleet', 'Notifications are working.', () => {})}
      >
        Send a test notification
      </button>
      <p className="modal-sub" style={{ marginTop: 10 }}>
        Alerts work for Claude Code agents. Codex agents only show badges when they stop or crash.
      </p>
    </div>
  )
}
