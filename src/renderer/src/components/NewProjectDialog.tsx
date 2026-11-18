import { useState } from 'react'
import { useStore } from '../store/useStore'

/** Modal for registering a new project (an existing git repo folder on disk). */
export function NewProjectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const createProject = useStore((s) => s.createProject)
  const [name, setName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
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
      await createProject({ name: name.trim(), localPath: localPath.trim(), githubUrl: githubUrl.trim() || undefined })
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
        <h2>New project</h2>
        <p className="modal-sub">Point to a folder that already contains a git repository.</p>

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
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </div>
    </div>
  )
}
