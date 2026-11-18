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
