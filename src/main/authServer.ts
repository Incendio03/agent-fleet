import { createServer, type Server } from 'node:http'

/**
 * Tiny loopback HTTP server for the OAuth redirect.
 *
 * Desktop OAuth can't use a normal web redirect (there's no web server) and
 * custom URL schemes (agentfleet://) are unreliable on Windows, especially in
 * dev. The battle-tested approach is a loopback redirect: we listen on
 * 127.0.0.1:<port>, point Supabase's redirect at it, and capture the ?code=...
 * the moment the browser lands here. Works identically in dev and when packaged.
 */
const PORT = 8923
export const AUTH_REDIRECT_URL = `http://localhost:${PORT}/callback`

let server: Server | null = null

export function startAuthServer(onCallback: (url: string) => void): void {
  if (server) return
  server = createServer((req, res) => {
    if (req.url && req.url.startsWith('/callback')) {
      onCallback(`http://localhost:${PORT}${req.url}`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Agent Fleet</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d0d10;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h2 style="color:#9ece6a">✅ Signed in</h2>
  <p>You can close this tab and return to Agent Fleet.</p>
</div>
<script>setTimeout(()=>window.close(), 1500)</script>
</body></html>`)
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
