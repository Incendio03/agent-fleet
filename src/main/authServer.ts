import { createServer, type Server } from 'node:http'

/**
 * Tiny loopback HTTP server on 127.0.0.1:8923, used for:
 *  - the OAuth redirect (GET /callback). Desktop OAuth can't use a normal web
 *    redirect and custom URL schemes (agentfleet://) are unreliable on Windows,
 *    so we listen here and capture the ?code=... when the browser lands.
 *  - agent hooks (POST /hook/...), for "needs you" alerts (see attention.ts).
 */
const PORT = 8923
export const HOOK_PORT = PORT
export const AUTH_REDIRECT_URL = `http://localhost:${PORT}/callback`

let server: Server | null = null

export function startAuthServer(
  onCallback: (url: string) => void,
  onHook?: (path: string, body: string) => void
): void {
  if (server) return
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/hook/') && onHook) {
      let body = ''
      req.on('data', (c) => {
        if (body.length < 64_000) body += c
      })
      req.on('end', () => {
        onHook(req.url!, body)
        res.writeHead(204)
        res.end()
      })
      return
    }
    if (req.url && req.url.startsWith('/callback')) {
      onCallback(`http://localhost:${PORT}${req.url}`)
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams
      const failed = !params.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        failed
          ? callbackPage('Sign-in didn’t complete', params.get('error_description') || 'Return to Agent Fleet and try again.', false)
          : callbackPage('You’re signed in', 'You can close this tab and return to Agent Fleet.', true)
      )
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('error', (err) => console.error('[auth-server]', err))
  server.listen(PORT, '127.0.0.1')
}

export function stopAuthServer(): void {
  server?.close()
  server = null
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The page the browser shows after the OAuth redirect (app colours, no emoji). */
function callbackPage(title: string, message: string, ok: boolean): string {
  const icon = ok
    ? '<path d="M8 12.5l2.5 2.5L16 9.5"/>'
    : '<path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Fleet</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         background: #0d0d10; color: #e6e6e6; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  .card { width: 100%; max-width: 360px; padding: 32px 28px; text-align: center;
          background: #15151b; border: 1px solid #2a2a35; border-radius: 12px; }
  .icon { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 50%; display: grid; place-items: center;
          border: 1.5px solid ${ok ? '#9ece6a' : '#e0af68'}; color: ${ok ? '#9ece6a' : '#e0af68'}; }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
  p { margin: 0; color: #9a9aa8; }
  .brand { margin-top: 24px; font-size: 12px; color: #6b6b78; letter-spacing: 0.02em; }
</style></head>
<body>
  <main class="card">
    <div class="icon"><svg width="22" height="22" viewBox="5 5 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="brand">Agent Fleet</div>
  </main>
</body></html>`
}
