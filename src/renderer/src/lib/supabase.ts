import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Optional Supabase integration.
 *
 * The app is local-first: if no Supabase keys are configured it runs entirely
 * offline and this module is inert. When keys ARE present, this gives us cloud
 * login (so projects/tabs follow the user across devices) using a desktop-friendly
 * PKCE OAuth flow: we open GitHub in the real browser, GitHub redirects to our
 * custom agentfleet:// scheme, the main process forwards that back, and we
 * exchange the code for a session here.
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

const REDIRECT_TO = 'agentfleet://auth'

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

export function onAuthChange(cb: (session: Session | null) => void): () => void {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session))
  return () => data.subscription.unsubscribe()
}
