import { useState } from 'react'
import { useStore } from '../store/useStore'
import type { EffortLevel, ModelAlias, PermissionMode } from '@shared/types'

const MODELS: { value: ModelAlias; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet — balanced (default)' },
  { value: 'opus', label: 'Opus — most capable' },
  { value: 'haiku', label: 'Haiku — fastest' }
]

const EFFORTS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

// The three interaction modes, mapped to claude --permission-mode values.
const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Confirm everything', hint: 'Agent asks before each action.' },
  { value: 'acceptEdits', label: 'Confirm risky steps only', hint: 'Auto-accepts edits, asks before running commands.' },
  { value: 'bypassPermissions', label: 'Let it work (autonomous)', hint: 'No prompts — agent runs on its own.' }
]

/** Modal for launching a new agent tab within the active project. */
export function NewTabDialog({ projectId, onClose }: { projectId: string; onClose: () => void }): JSX.Element {
  const createTab = useStore((s) => s.createTab)
  const [title, setTitle] = useState('')
  const [task, setTask] = useState('')
  const [model, setModel] = useState<ModelAlias>('sonnet')
  const [effort, setEffort] = useState<EffortLevel>('high')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setErr(null)
    if (!title.trim()) {
      setErr('Give the task a short title (used for the branch name).')
      return
    }
    setBusy(true)
    try {
      await createTab({ projectId, title: title.trim(), task: task.trim(), model, effort, permissionMode })
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>New agent tab</h2>
        <p className="modal-sub">A fresh git worktree + branch will be created so this agent is isolated.</p>

        <label>Task title</label>
        <input value={title} placeholder="add-login-page" onChange={(e) => setTitle(e.target.value)} />

        <label>Task prompt (what should the agent do?)</label>
        <textarea
          value={task}
          rows={4}
          placeholder="Add a login page with email + password using our existing auth helpers."
          onChange={(e) => setTask(e.target.value)}
        />

        <div className="grid-2">
          <div>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value as ModelAlias)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Effort</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>
        </div>

        <label>Interaction mode</label>
        <div className="mode-list">
          {MODES.map((m) => (
            <label key={m.value} className={`mode-option ${permissionMode === m.value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="mode"
                checked={permissionMode === m.value}
                onChange={() => setPermissionMode(m.value)}
              />
              <div>
                <div className="mode-title">{m.label}</div>
                <div className="mode-hint">{m.hint}</div>
              </div>
            </label>
          ))}
        </div>

        {err && <div className="error-box">{err}</div>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Launching…' : 'Launch agent'}
          </button>
        </div>
      </div>
    </div>
  )
}
