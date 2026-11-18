import { useState } from 'react'
import { useStore } from '../store/useStore'
import type { Project } from '@shared/types'

/** Modal for registering a new project, or editing one when `project` is given. */
export function NewProjectDialog({ onClose, project }: { onClose: () => void; project?: Project }): JSX.Element {
  const createProject = useStore((s) => s.createProject)
  const updateProject = useStore((s) => s.updateProject)
  const editing = project != null
  const [name, setName] = useState(project?.name ?? '')
  const [localPath, setLocalPath] = useState(project?.localPath ?? '')
  const [githubUrl, setGithubUrl] = useState(project?.githubUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    const folder = await window.fleet.pickFolder()
    if (folder) {
      setLocalPath(folder)
      // Default the name to the folder name if empty.
      if (!name) setName(folder.split(/[\\/]/).pop() || '')
    }
  }

  const submit = async (): Promise<void> => {
    setErr(null)
    if (!name.trim() || !localPath.trim()) {
      setErr('Name and folder are required.')
      return
    }
    setBusy(true)
    try {
      const opts = { name: name.trim(), localPath: localPath.trim(), githubUrl: githubUrl.trim() || undefined }
      if (project) await updateProject(project.id, opts)
      else await createProject(opts)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? 'Edit project' : 'New project'}</h2>
        <p className="modal-sub">
          {editing
            ? 'Changing the folder moves this project’s agents to it on their next resume. Claude keeps conversation history per folder, so a moved agent may start a fresh conversation.'
            : 'Pick any folder — a single git repo (agents get isolated branches) or a folder holding several repos (agents run directly in it).'}
        </p>

        <label>Folder</label>
        <div className="row">
          <input value={localPath} placeholder="C:\path\to\repo" onChange={(e) => setLocalPath(e.target.value)} />
          <button className="btn" onClick={pick}>Browse…</button>
        </div>

        <label>Name</label>
        <input value={name} placeholder="my-website" onChange={(e) => setName(e.target.value)} />

        <label>GitHub URL (optional)</label>
        <input
          value={githubUrl}
          placeholder="https://github.com/you/my-website"
          onChange={(e) => setGithubUrl(e.target.value)}
        />

        {err && <div className="error-box">{err}</div>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add project'}
          </button>
        </div>
      </div>
    </div>
  )
}
