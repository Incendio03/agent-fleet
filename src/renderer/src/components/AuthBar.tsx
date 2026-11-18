import { useEffect, useState } from 'react'
import {
  isCloudEnabled,
  startGitHubLogin,
  completeLoginFromCallback,
  signOut,
  getSession,
  onAuthChange
} from '../lib/supabase'
import { useStore } from '../store/useStore'

/**
 * Sidebar footer: cloud sign-in state.
 *
 * - Cloud not configured  -> shows a quiet "Local only" note.
 * - Signed out            -> "Sign in with GitHub".
 * - Signed in             -> email + sign out; restores cloud data on login.
 */
export function AuthBar({ compact = false }: { compact?: boolean } = {}): JSX.Element {
  const restoreFromCloud = useStore((s) => s.restoreFromCloud)
  const setError = useStore((s) => s.setError)
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isCloudEnabled) return

    void getSession().then((s) => setEmail(s?.user?.email ?? null))

    // React to login/logout; pull cloud data when a session appears.
    const offAuth = onAuthChange((session) => {
      setEmail(session?.user?.email ?? null)
      if (session) void restoreFromCloud()
    })

    // The main process forwards the agentfleet://auth?code=... deep link here.
    const offCb = window.fleet.onAuthCallback((url) => {
      completeLoginFromCallback(url).catch((e) => setError((e as Error).message))
    })

    return () => {
      offAuth()
      offCb()
    }
  }, [restoreFromCloud, setError])

  if (!isCloudEnabled) {
    if (compact) {
      return (
        <div className="authbar compact">
          <span className="rail-note" title="Local only — add Supabase keys to .env to enable cloud login">●</span>
        </div>
      )
    }
    return (
      <div className="authbar">
        <span className="auth-note" title="Add Supabase keys to .env to enable cloud login">
          ● Local only
        </span>
      </div>
    )
  }

  const login = async (): Promise<void> => {
    setBusy(true)
    try {
      await startGitHubLogin()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmSignOut = (): void => {
    if (confirm('Sign out of Agent Fleet?\n\nCloud sync stops until you sign in again. Your projects and agents stay on this computer.')) {
      void signOut()
    }
  }

  // Collapsed sidebar: one icon button (green dot = signed in).
  if (compact) {
    return (
      <div className="authbar compact">
        <button
          className={`rail-btn account ${email ? 'signed-in' : ''}`}
          onClick={email ? confirmSignOut : login}
          disabled={busy}
          title={email ? `Signed in as ${email}\nClick to sign out` : 'Sign in with GitHub'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div className="authbar">
      {email ? (
        <>
          <span className="auth-email" title={email}>● {email}</span>
          <button className="btn ghost sm" onClick={confirmSignOut}>Sign out</button>
        </>
      ) : (
        <button className="btn sm" onClick={login} disabled={busy}>
          {busy ? 'Opening browser…' : 'Sign in with GitHub'}
        </button>
      )}
    </div>
  )
}
