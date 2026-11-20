import { useCallback, useEffect, useState } from 'react'
import type { AgentKind, SkillFile, SkillInfo, SkillStage } from '@shared/types'
import { useStore } from '../store/useStore'
import { useChatStore } from '../store/useChatStore'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const agentLabel = (id: AgentKind): string => (id === 'claude' ? 'Claude' : 'Codex')

const GROUPS: { scope: SkillInfo['scope']; title: (a: AgentKind) => string }[] = [
  { scope: 'personal', title: () => 'Installed by you' },
  { scope: 'project', title: () => 'In your projects' },
  { scope: 'synced', title: () => 'From your Claude account' },
  { scope: 'builtin', title: (a) => `Built into ${agentLabel(a)}` }
]

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** The files of a skill, scripts marked. */
function FileList({ files }: { files: SkillFile[] }): JSX.Element {
  return (
    <ul className="skill-files">
      {files.map((f) => (
        <li key={f.path} className={f.script ? 'script' : ''}>
          <span>{f.path}</span>
          <span className="skill-file-meta">{f.script ? 'script · ' : ''}{size(f.size)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings → Skills: a tab per installed agent, listing its skills by where they
 * come from. Your own skills can be turned off or removed. Installing (from a
 * folder, a .zip or a GitHub link) always shows what's inside first.
 */
export function SkillsSettings(): JSX.Element {
  const agents = useStore((s) => s.agents).filter((a) => a.available)
  const [tab, setTab] = useState<AgentKind | null>(null)
  const agent = tab && agents.some((a) => a.id === tab) ? tab : agents[0]?.id ?? null
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [viewing, setViewing] = useState<SkillInfo | null>(null)
  const [stage, setStage] = useState<SkillStage | null>(null)
  const [github, setGithub] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!agent) return
    try {
      const list = await window.fleet.listSkills(agent)
      setSkills(list)
      useChatStore.getState().setSkills(agent, list)
    } catch (e) {
      setError(`Could not read the skills: ${message(e)}`)
    }
  }, [agent])

  useEffect(() => {
    setSkills(null)
    setViewing(null)
    void refresh()
  }, [refresh])

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  const startInstall = async (source: 'folder' | 'zip' | 'github'): Promise<void> => {
    if (!agent) return
    setBusy(source === 'github' ? 'Downloading…' : 'Reading…')
    setError(null)
    try {
      const st = await window.fleet.stageSkills(source === 'github' ? { kind: 'github', url: github ?? '' } : { kind: source })
      if (st) {
        setStage(st)
        setGithub(null)
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  if (!window.fleet.listSkills) {
    return (
      <div className="settings-section">
        <h3 className="settings-title">Skills</h3>
        <p className="modal-sub">Restart the app to manage skills here.</p>
      </div>
    )
  }

  if (stage && agent) {
    return (
      <InstallReview
        stage={stage}
        agent={agent}
        installed={skills ?? []}
        onDone={() => {
          setStage(null)
          void refresh()
        }}
      />
    )
  }

  if (viewing) return <SkillDetails skill={viewing} onBack={() => setViewing(null)} />

  return (
    <div className="settings-section">
      <h3 className="settings-title">Skills</h3>
      <p className="modal-sub">
        Skills teach an agent how to handle a particular kind of task. Each agent has its own.
        Agent tabs load the skills that are on when they start (restart a running agent to pick up
        a change). Chats use only the skills you turn on in that chat.
      </p>

      {agents.length === 0 ? (
        <p className="modal-sub">No agent program is installed. See the Agents section.</p>
      ) : (
        <>
          <div className="skill-tabs" role="tablist">
            {agents.map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={a.id === agent}
                className={`skill-tab ${a.id === agent ? 'active' : ''}`}
                onClick={() => setTab(a.id)}
              >
                {agentLabel(a.id)}
              </button>
            ))}
          </div>

          <div className="skill-toolbar">
            <span>Install a skill:</span>
            <button className="btn sm" disabled={!!busy} onClick={() => void startInstall('folder')}>From folder…</button>
            <button className="btn sm" disabled={!!busy} onClick={() => void startInstall('zip')}>From .zip…</button>
            <button className="btn sm" disabled={!!busy} onClick={() => setGithub(github === null ? '' : null)}>From GitHub…</button>
            {busy && <span className="skill-busy"><span className="spinner sm" />{busy}</span>}
          </div>
          {github !== null && (
            <form
              className="skill-github"
              onSubmit={(e) => {
                e.preventDefault()
                void startInstall('github')
              }}
            >
              <input
                autoFocus
                value={github}
                placeholder="https://github.com/owner/repo  or  …/tree/main/path/to/skill"
                onChange={(e) => setGithub(e.target.value)}
              />
              <button className="btn sm primary" disabled={!github.trim() || !!busy}>Look inside</button>
            </form>
          )}
          {error && <div className="error-box">{error}</div>}

          {skills === null ? (
            <div className="empty-hint"><span className="spinner sm" /> Loading…</div>
          ) : (
            GROUPS.map((g) => {
              const items = skills.filter((s) => s.scope === g.scope)
              if (!items.length && g.scope !== 'personal') return null
              return (
                <section key={g.scope} className="skill-group">
                  <h4>{g.title(agent!)}</h4>
                  {items.length === 0 && <div className="skill-empty">No skills installed yet.</div>}
                  {items.map((s) => (
                    <div key={s.path} className={`skill-row ${s.enabled ? '' : 'off'}`}>
                      <div className="skill-main">
                        <div className="skill-name">
                          {s.name}
                          {s.project && <span className="skill-tag">{s.project}</span>}
                          {s.hasScripts && <span className="skill-tag warn" title="Ships scripts or programs that agents can run">scripts</span>}
                          {!s.enabled && <span className="skill-tag">off</span>}
                        </div>
                        <div className="skill-desc" title={s.description}>{s.description || 'No description.'}</div>
                      </div>
                      <div className="skill-actions">
                        <button className="btn sm ghost" onClick={() => setViewing(s)}>View</button>
                        {s.scope === 'personal' && (
                          <>
                            <label className="switch" title={s.enabled ? 'On: agents can use it' : 'Off: agents ignore it'}>
                              <input
                                type="checkbox"
                                checked={s.enabled}
                                disabled={!!busy}
                                onChange={(e) => void act('Saving…', () => window.fleet.setSkillEnabled(s.agent, s.name, e.target.checked))}
                              />
                              <span />
                            </label>
                            <button
                              className="btn sm ghost danger"
                              disabled={!!busy}
                              onClick={() => {
                                if (confirm(`Remove the skill "${s.name}"?\n\nIt goes to the Recycle Bin, so you can restore it from there.`)) {
                                  void act('Removing…', () => window.fleet.removeSkill(s.agent, s.name))
                                }
                              }}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              )
            })
          )}
        </>
      )}
    </div>
  )
}

/** One installed skill: its SKILL.md and files. */
function SkillDetails({ skill, onBack }: { skill: SkillInfo; onBack: () => void }): JSX.Element {
  const [detail, setDetail] = useState<{ skillMd: string; files: SkillFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.fleet.readSkill(skill.path).then(setDetail).catch((e) => setError(message(e)))
  }, [skill.path])

  return (
    <div className="settings-section">
      <button className="skill-back" onClick={onBack}>← Skills</button>
      <h3 className="settings-title">{skill.name}</h3>
      <p className="modal-sub">{skill.description}</p>
      <div className="skill-path">
        <code>{skill.path}</code>
        <button className="btn sm ghost" onClick={() => void window.fleet.revealSkill(skill.path)}>Show in folder</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {detail && (
        <>
          <h4 className="skill-subhead">Files</h4>
          <FileList files={detail.files} />
          <h4 className="skill-subhead">SKILL.md</h4>
          <pre className="skill-md">{detail.skillMd}</pre>
        </>
      )}
    </div>
  )
}

/** What was found in a folder / zip / GitHub link: review, choose, then install. */
function InstallReview({
  stage,
  agent,
  installed,
  onDone
}: {
  stage: SkillStage
  agent: AgentKind
  installed: SkillInfo[]
  onDone: () => void
}): JSX.Element {
  const installable = stage.skills.filter((s) => !s.errors.length)
  // Nothing is ticked when there are several: you choose what to take.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(installable.length === 1 ? [installable[0].dir] : []))
  const [open, setOpen] = useState<string | null>(stage.skills.length === 1 ? stage.skills[0].dir : null)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mine = new Set(installed.filter((s) => s.scope === 'personal').map((s) => s.name))
  const conflicts = stage.skills.filter((s) => chosen.has(s.dir) && mine.has(s.name))
  const anyScripts = stage.skills.some((s) => chosen.has(s.dir) && s.files.some((f) => f.script))

  const cancel = (): void => {
    void window.fleet.discardSkills(stage.id)
    onDone()
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.fleet.installSkills(stage.id, agent, [...chosen], replace)
      onDone()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <button className="skill-back" onClick={cancel}>← Skills</button>
      <h3 className="settings-title">Review before installing</h3>
      <p className="modal-sub">
        A skill is a set of instructions (sometimes with scripts) that {agentLabel(agent)} will follow.
        Only install skills from sources you trust. Found in <code>{stage.source}</code>:
      </p>

      <div className="skill-review">
        {stage.skills.map((s) => {
          const blocked = s.errors.length > 0
          return (
            <div key={s.dir || '.'} className={`skill-review-item ${blocked ? 'blocked' : ''}`}>
              <label className="skill-review-head">
                <input
                  type="checkbox"
                  disabled={blocked || busy}
                  checked={chosen.has(s.dir)}
                  onChange={(e) => {
                    const next = new Set(chosen)
                    if (e.target.checked) next.add(s.dir)
                    else next.delete(s.dir)
                    setChosen(next)
                  }}
                />
                <div className="skill-main">
                  <div className="skill-name">
                    {s.name}
                    {mine.has(s.name) && <span className="skill-tag warn">already installed</span>}
                    {s.files.some((f) => f.script) && <span className="skill-tag warn">scripts</span>}
                  </div>
                  <div className="skill-desc">{s.description || 'No description.'}</div>
                </div>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={(e) => {
                    e.preventDefault()
                    setOpen(open === s.dir ? null : s.dir)
                  }}
                >
                  {open === s.dir ? 'Hide' : 'Look inside'}
                </button>
              </label>
              {s.errors.map((m) => <div key={m} className="skill-note error">{m}</div>)}
              {s.warnings.map((m) => <div key={m} className="skill-note warn">{m}</div>)}
              {open === s.dir && (
                <div className="skill-inside">
                  <h4 className="skill-subhead">Files ({s.files.length})</h4>
                  <FileList files={s.files} />
                  <h4 className="skill-subhead">SKILL.md</h4>
                  <pre className="skill-md">{s.skillMd}</pre>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {conflicts.length > 0 && (
        <label className="settings-toggle">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <div>
            <div className="settings-toggle-title">Replace what's installed</div>
            <div className="settings-toggle-hint">
              {conflicts.map((c) => c.name).join(', ')} {conflicts.length === 1 ? 'is' : 'are'} already installed. The current
              {conflicts.length === 1 ? ' one goes' : ' ones go'} to the Recycle Bin.
            </div>
          </div>
        </label>
      )}
      {anyScripts && (
        <div className="skill-note warn">
          You're installing scripts. Agent tabs can run them with their own permissions, so check them first.
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={cancel} disabled={busy}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || chosen.size === 0 || (conflicts.length > 0 && !replace)}
          onClick={() => void install()}
        >
          {busy ? 'Installing…' : `Install ${chosen.size === 1 ? 'skill' : `${chosen.size} skills`} for ${agentLabel(agent)}`}
        </button>
      </div>
    </div>
  )
}
