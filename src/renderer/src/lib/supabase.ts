import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Optional Supabase integration.
 *
 * The app is local-first: if no Supabase keys are configured it runs entirely
 * offline and this module is inert. When keys ARE present, this gives us cloud
 * login (so projects/tabs follow the user across devices) using a desktop-friendly
 * PKCE OAuth flow: we open GitHub in the real browser, Supabase redirects to a
 * loopback URL (http://localhost:8923/callback) served by the main process,
 * which forwards the code back here to exchange for a session.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isCloudEnabled = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = isCloudEnabled
  ? createClient(url!, anonKey!, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // We handle the redirect ourselves via the deep link, not a URL bar.
        detectSessionInUrl: false
      }
    })
  : null

// Must match the loopback server in src/main/authServer.ts (port 8923).
const REDIRECT_TO = 'http://localhost:8923/callback'

/** Kick off GitHub sign-in: returns the URL to open in the external browser. */
export async function startGitHubLogin(): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured.')
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true }
  })
  if (error) throw error
  if (data?.url) await window.fleet.openExternal(data.url)
}

/** Complete sign-in from the agentfleet://auth?code=... callback URL. */
export async function completeLoginFromCallback(callbackUrl: string): Promise<void> {
  if (!supabase) return
  const code = new URL(callbackUrl).searchParams.get('code')
  if (!code) throw new Error('No auth code in callback URL.')
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session
}

export function onAuthChange(cb: (session: Session | null, event: string) => void): () => void {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange((e, session) => cb(session, e))
  return () => data.subscription.unsubscribe()
}

/** The signed-in account, as far as the app needs it. */
export interface Account {
  id: string
  email: string | null
}

export function accountOf(session: Session): Account {
  return { id: session.user.id, email: session.user.email ?? null }
}

/**
 * The signed-in account, or null when signed out. Offline with an expired
 * access token getSession() can't refresh and returns null, but the account is
 * still signed in (its session is still saved), so fall back to the saved one —
 * otherwise an offline start would show the signed-out projects.
 */
export async function currentAccount(): Promise<Account | null> {
  if (!supabase) return null
  const session = await getSession().catch(() => null)
  if (session) return accountOf(session)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue
      const user = JSON.parse(localStorage.getItem(key) ?? 'null')?.user
      if (typeof user?.id === 'string') return { id: user.id, email: typeof user.email === 'string' ? user.email : null }
    }
  } catch {
    // unreadable storage: treat as signed out
  }
  return null
}
