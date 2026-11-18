import { useState } from 'react'
import type { AgentInfo, AgentKind, Tab } from '@shared/types'
import { useStore } from '../store/useStore'

/** Models for an agent, always including the tab's current value even if not detected. */
export function modelOptions(agent: AgentInfo | undefined, current?: string): { id: string; label: string }[] {
  const list = agent?.models.map((m) => ({ id: m.id, label: m.label })) ?? []
  if (current && !list.some((m) => m.id === current)) list.unshift({ id: current, label: current })
  return list
}

/** Efforts valid for the chosen model (falls back to the agent's full list). */
export function effortOptions(agent: AgentInfo | undefined, model?: string, current?: string): string[] {
  const list = agent?.models.find((m) => m.id === model)?.efforts ?? agent?.efforts ?? []
  return current && !list.includes(current) ? [current, ...list] : list
}

/**
 * Bar above the terminal for switching the tab's agent CLI, model and effort.
 * Options are detected on this machine. A running agent is restarted to apply
 * the change: same agent → resumes the conversation; different agent → fresh.
 */
export function AgentBar({ tab }: { tab: Tab }): JSX.Element {
  const agents = useStore((s) => s.agents)
  const updateTab = useStore((s) => s.updateTab)
  const restartTab = useStore((s) => s.restartTab)
  const isLive = useStore((s) => s.liveTabIds.has(tab.id))
  const [busy, setBusy] = useState(false)

  const kind: AgentKind = tab.agent ?? 'claude'
  const agent = agents.find((a) => a.id === kind)

  const apply = async (patch: { agent?: AgentKind; model?: string; effort?: string }): Promise<void> => {
    const agentChanged = patch.agent != null && patch.agent !== kind
    if (agentChanged && isLive && !confirm(
      `Switch this tab to ${agents.find((a) => a.id === patch.agent)?.label}?\n\n` +
      `A different agent can't continue this conversation, so it starts fresh in the same folder.`
    )) return
    setBusy(true)
    try {
      await updateTab(tab.id, {
        title: tab.title,
        task: tab.task,
        permissionMode: tab.permissionMode,
        agent: patch.agent ?? kind,
        model: patch.model ?? tab.model,
        effort: patch.effort ?? tab.effort
      })
      if (isLive) await restartTab(tab.id, agentChanged)
    } finally {
      setBusy(false)
    }
  }

  const onAgent = (id: AgentKind): void => {
    const next = agents.find((a) => a.id === id)
    // Pick sensible defaults for the new agent: its first model + a mid effort.
    const model = next?.models[0]?.id ?? ''
    const efforts = effortOptions(next, model)
    const effort = efforts.includes(tab.effort) ? tab.effort : efforts.includes('medium') ? 'medium' : efforts[0] ?? ''
    void apply({ agent: id, model, effort })
  }

  const onModel = (model: string): void => {
    const efforts = effortOptions(agent, model)
    void apply({ model, effort: efforts.includes(tab.effort) ? tab.effort : efforts[0] ?? tab.effort })
  }

  const hint = isLive ? 'Changing restarts the agent' : 'Applies when the agent starts'
  return (
    <div className="agent-bar">
      <label className="agent-field" title={`Agent — ${hint}`}>
        <IconAgent />
        <select value={kind} disabled={busy} onChange={(e) => onAgent(e.target.value as AgentKind)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>
              {a.label}{a.available ? '' : ' (not installed)'}
            </option>
          ))}
          {!agent && <option value={kind}>{kind}</option>}
        </select>
      </label>
      <label className="agent-field" title={`Model — ${hint}`}>
        <IconModel />
        <select value={tab.model} disabled={busy} onChange={(e) => onModel(e.target.value)}>
          {modelOptions(agent, tab.model).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label className="agent-field" title={`Effort — ${hint}`}>
        <IconEffort />
        <select value={tab.effort} disabled={busy} onChange={(e) => void apply({ effort: e.target.value })}>
          {effortOptions(agent, tab.model, tab.effort).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      {busy && <span className="agent-bar-note">Restarting…</span>}
    </div>
  )
}

const svg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

/** Robot head: which agent program. */
function IconAgent(): JSX.Element {
  return (
    <svg {...svg} aria-label="Agent">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="15" cy="14" r="1" fill="currentColor" />
    </svg>
  )
}

/** Chip: which model. */
function IconModel(): JSX.Element {
  return (
    <svg {...svg} aria-label="Model">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  )
}

/** Gauge: how hard it thinks. */
function IconEffort(): JSX.Element {
  return (
    <svg {...svg} aria-label="Effort">
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-6" />
    </svg>
  )
}
