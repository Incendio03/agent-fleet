import { useState } from 'react'
import { useStore } from '../store/useStore'
import type { AgentKind, EffortLevel, ModelAlias, PermissionMode, Tab } from '@shared/types'
import { modelOptions, effortOptions } from './AgentBar'

// The three interaction modes, mapped to claude --permission-mode values.
const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Confirm everything', hint: 'Agent asks before each action.' },
  { value: 'acceptEdits', label: 'Confirm risky steps only', hint: 'Auto-accepts edits, asks before running commands.' },
  { value: 'bypassPermissions', label: 'Let it work (autonomous)', hint: 'No prompts — agent runs on its own.' }
]

/** Modal for launching a new agent tab, or editing one when `tab` is given. */
export function NewTabDialog({
  projectId,
  onClose,
  tab
}: {
  projectId: string
  onClose: () => void
  tab?: Tab
}): JSX.Element {
  const createTab = useStore((s) => s.createTab)
  const updateTab = useStore((s) => s.updateTab)
  const isLive = useStore((s) => (tab ? s.liveTabIds.has(tab.id) : false))
  const editing = tab != null
  const [title, setTitle] = useState(tab?.title ?? '')
  const [task, setTask] = useState(tab?.task ?? '')
  const agents = useStore((s) => s.agents)
  const [agentKind, setAgentKind] = useState<AgentKind>(tab?.agent ?? 'claude')
  const agent = agents.find((a) => a.id === agentKind)
  const [model, setModel] = useState<ModelAlias>(tab?.model ?? 'sonnet')
  const [effort, setEffort] = useState<EffortLevel>(tab?.effort ?? 'high')
  const pickAgent = (id: AgentKind): void => {
    setAgentKind(id)
    const next = agents.find((a) => a.id === id)
    const m = next?.models[0]?.id ?? ''
    setModel(m)
    const efforts = effortOptions(next, m)
    setEffort(efforts.includes('medium') ? 'medium' : efforts[0] ?? '')
  }
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(tab?.permissionMode ?? 'acceptEdits')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setErr(null)
    if (!title.trim()) {
      setErr('Give the agent a name (e.g. "Software Engineer").')
      return
    }
    setBusy(true)
    try {
      if (tab) {
        await updateTab(tab.id, { title: title.trim(), task: task.trim(), agent: agentKind, model, effort, permissionMode })
        onClose()
        return
      }
      // Agents run directly in the project folder; they create branches
      // themselves when asked, so no worktree is forced here.
      await createTab({
        projectId,
        title: title.trim(),
        agent: agentKind,
        task: task.trim(),
        model,
        effort,
        permissionMode,
        isolate: false
      })
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
        <h2>{editing ? 'Edit agent' : 'New agent'}</h2>
        <p className="modal-sub">
          {editing
            ? `Name changes apply now. Model, effort and mode apply the next time this agent is launched or resumed${isLive ? ' (it is running now — /exit it and resume to switch)' : ''}. Instructions are only sent on a fresh start.`
            : 'An agent that works in this project. It runs in the project folder — tell it to create a branch whenever you want one.'}
        </p>

        <label>Agent name / role</label>
        <input
          value={title}
          list="agent-role-suggestions"
          placeholder="Software Engineer"
          onChange={(e) => setTitle(e.target.value)}
        />
        <datalist id="agent-role-suggestions">
          <option value="Software Engineer" />
          <option value="Project Manager" />
          <option value="Code Reviewer" />
          <option value="QA / Tester" />
          <option value="DevOps Engineer" />
          <option value="Technical Writer" />
        </datalist>

        <label>Role / instructions (optional)</label>
        <textarea
          value={task}
          rows={4}
          placeholder="You are my senior software engineer on this project. Help me plan, build, and debug features. Ask before large changes."
          onChange={(e) => setTask(e.target.value)}
        />

        <div className="grid-3">
          <div>
            <label>Agent</label>
            <select value={agentKind} onChange={(e) => pickAgent(e.target.value as AgentKind)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available}>
                  {a.label}{a.available ? '' : ' (not installed)'}
                </option>
              ))}
              {agents.length === 0 && <option value={agentKind}>Claude Code</option>}
            </select>
          </div>
          <div>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions(agent, model).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Effort</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              {effortOptions(agent, model, effort).map((x) => (
                <option key={x} value={x}>{x}</option>
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
            {busy ? (editing ? 'Saving…' : 'Launching…') : editing ? 'Save' : 'Launch agent'}
          </button>
        </div>
      </div>
    </div>
  )
}
