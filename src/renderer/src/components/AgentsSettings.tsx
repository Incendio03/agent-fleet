import { useCallback, useEffect, useState } from 'react'
import type { AgentKind, AgentStatus } from '@shared/types'
import { useStore } from '../store/useStore'
import { TerminalView } from './TerminalView'

/**
 * Settings → Agents section: every supported agent CLI with its install and sign-in
 * state. Sign-in runs the CLI's own login flow in an embedded terminal, so
 * credentials stay with each CLI — Agent Fleet never sees them.
 */
export function AgentsSettings(): JSX.Element {
  const agents = useStore((s) => s.agents)
  const setAgents = useStore((s) => s.setAgents)
  const [status, setStatus] = useState<Partial<Record<AgentKind, AgentStatus>>>({})
  const [checking, setChecking] = useState(false)
  const [loginFor, setLoginFor] = useState<{ id: AgentKind; sid: string } | null>(null)
  const [busy, setBusy] = useState<AgentKind | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const list = await window.fleet.listAgents(true) // re-detect installs/models too
      setAgents(list)
      const all = await Promise.all(list.map((a) => window.fleet.agentStatus(a.id)))
      setStatus(Object.fromEntries(all.map((s) => [s.id, s])))
    } catch (e) {
      useStore.getState().setError(
        /No handler registered/i.test((e as Error).message)
          ? 'Agent status needs a full app restart (stop and re-run npm run dev) to load the new backend code.'
          : `Could not check agents: ${(e as Error).message}`
      )
    } finally {
      setChecking(false)
    }
  }, [setAgents])

  useEffect(() => { void refresh() }, [refresh])

  // When the sign-in terminal's process ends, re-check who's signed in.
  useEffect(() => {
    if (!loginFor) return
    return window.fleet.onTabExit((id) => { if (id === loginFor.sid) void refresh() })
  }, [loginFor, refresh])

  const setError = useStore((s) => s.setError)

  const signIn = async (id: AgentKind): Promise<void> => {
    setBusy(id)
    try {
      const sid = await window.fleet.agentLogin(id)
      setLoginFor({ id, sid })
    } catch (e) {
      const msg = (e as Error).message
      setError(
        /No handler registered/i.test(msg)
          ? 'Sign-in needs a full app restart (stop and re-run npm run dev) to load the new backend code.'
          : `Could not start sign-in: ${msg}`
      )
    } finally {
      setBusy(null)
    }
  }

  const signOut = async (id: AgentKind): Promise<void> => {
    const label = agents.find((a) => a.id === id)?.label ?? id
    if (!confirm(`Sign out of ${label}?\n\nEvery ${label} tab uses this login; running agents may stop working until you sign in again.`)) return
    setBusy(id)
    try {
      await window.fleet.agentLogout(id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const closeLogin = (): void => {
    if (loginFor) void window.fleet.killSession(loginFor.sid)
    setLoginFor(null)
    void refresh()
  }

  return (
    <div className="settings-section">
        <div className="agents-head">
          <h3>Agents</h3>
          <button className="btn sm" disabled={checking} onClick={() => void refresh()}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        <p className="modal-sub">
          Agent programs installed on this computer. Each one keeps its own login, shared by all
          of its tabs. Agent Fleet never sees your credentials.
        </p>

        {loginFor ? (
          <div className="agent-login">
            <div className="agent-login-head">
              <b>Sign in to {agents.find((a) => a.id === loginFor.id)?.label}</b>
              <span>Follow the steps below. A browser window may open.</span>
            </div>
            <div className="agent-login-term">
              <TerminalView tabId={loginFor.sid} active />
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={closeLogin}>Done</button>
            </div>
          </div>
        ) : (
          <div className="agent-cards">
            {agents.map((a) => {
              const s = status[a.id]
              return (
                <div key={a.id} className="agent-card">
                  <div className="agent-card-main">
                    <div className="agent-card-title">
                      {a.label}
                      {s?.version && <span className="agent-version">{s.version}</span>}
                    </div>
                    <div className="agent-card-status">
                      {!s ? (
                        <span className="dim">Checking…</span>
                      ) : !s.installed ? (
                        <span className="warn">Not installed</span>
                      ) : s.loggedIn ? (
                        <span className="ok">● Signed in{s.account ? ` — ${s.account}` : ''}</span>
                      ) : (
                        <span className="warn">● Not signed in</span>
                      )}
                    </div>
                    {s && !s.installed && (
                      <div className="agent-install">
                        Install it, then click Re-check:
                        <code>{s.install}</code>
                        <a href="#" onClick={(e) => { e.preventDefault(); if (s.docs) void window.fleet.openExternal(s.docs) }}>
                          Setup guide ↗
                        </a>
                      </div>
                    )}
                  </div>
                  {s?.installed && (
                    <div className="agent-card-actions">
                      {s.loggedIn ? (
                        <>
                          <button className="btn sm" onClick={() => void signIn(a.id)} title="Sign in with a different account">Switch account</button>
                          <button className="btn sm ghost" disabled={busy === a.id} onClick={() => void signOut(a.id)}>Sign out</button>
                        </>
                      ) : (
                        <button className="btn sm primary" disabled={busy === a.id} onClick={() => void signIn(a.id)}>{busy === a.id ? "Starting…" : "Sign in"}</button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="agent-more">
              More agent types (e.g. Gemini CLI) can be added in a future version. Installed ones
              appear here automatically.
            </div>
          </div>
        )}

    </div>
  )
}
