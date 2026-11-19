import { useEffect, useState } from 'react'
import type { AppPrefs } from '@shared/types'
import { useStore } from '../store/useStore'

/** Settings → Terminal: how agents' terminals behave. */
export function TerminalSettings(): JSX.Element {
  const [prefs, setPrefs] = useState<AppPrefs | null>(null)
  const setError = useStore((s) => s.setError)

  useEffect(() => {
    window.fleet.getPrefs?.().then(setPrefs).catch(() => {
      setError('Terminal settings need a full app restart to load.')
    })
  }, [setError])

  const update = async (patch: Partial<AppPrefs>): Promise<void> => {
    try {
      setPrefs(await window.fleet.setPrefs(patch))
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`)
    }
  }

  return (
    <div className="settings-section">
      <h3 style={{ margin: 0, fontSize: 15 }}>Terminal</h3>
      <p className="modal-sub">How Claude agents draw in their tabs.</p>

      <label className={`settings-toggle ${prefs ? '' : 'disabled'}`}>
        <input
          type="checkbox"
          disabled={!prefs}
          checked={prefs?.classicScrolling ?? true}
          onChange={(e) => void update({ classicScrolling: e.target.checked })}
        />
        <div>
          <div className="settings-toggle-title">Classic scrolling</div>
          <div className="settings-toggle-hint">
            The conversation stays in the terminal's history: the scrollbar follows the mouse wheel
            and text selection works normally. Turn off to use Claude Code's full-screen interface
            (if you've enabled it), which scrolls on its own. Only affects agents in Agent Fleet.
          </div>
        </div>
      </label>
      <p className="modal-sub" style={{ marginTop: 10 }}>
        Applies when an agent starts: new agents, resumed ones, or after changing its model or effort.
      </p>
    </div>
  )
}
