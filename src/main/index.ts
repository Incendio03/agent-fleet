import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { detectClaude } from './claude'
import { sessionManager } from './sessionManager'
import { startAuthServer, stopAuthServer } from './authServer'
import { store } from './store'
import { IPC } from '@shared/types'

let mainWindow: BrowserWindow | null = null

/** Hand an OAuth callback URL (from the loopback server) to the UI + refocus. */
function forwardAuthCallback(url: string): void {
  mainWindow?.webContents.send(IPC.authCallback, url)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0d10',
    title: 'Agent Fleet',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false, // required so the preload can use Node's contextBridge
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // side browser panel
    }
  })

  // Lock down side-browser <webview>s: no preload, no Node, web URLs only.
  mainWindow.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    if (!/^(https?:|about:blank)/.test(params.src)) e.preventDefault()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })

  // No File/Edit/View menu bar. Copy/paste in inputs and terminals don't need
  // it; keep the DevTools shortcut in dev only, since the menu provided that.
  mainWindow.removeMenu()
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      const devtools =
        input.type === 'keyDown' &&
        (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))
      if (devtools) mainWindow?.webContents.toggleDevTools()
    })
  }

  // Open external links in the real browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite injects this env var in dev to point at the Vite dev server.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single instance so the loopback auth server port is never double-bound.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Links that try to open a new window inside the side browser load in place.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return
  // Links that want a new window (target=_blank, window.open) open a browser tab.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserOpenTab, url)
      else void wc.loadURL(url)
    }
    return { action: 'deny' }
  })

  // Browser-style zoom: Ctrl +/-/0 and Ctrl+mouse wheel. Keys pressed inside
  // the page never reach the host window, so handle them on the page itself.
  const zoom = (delta: number | null): void => {
    const level = delta === null ? 0 : Math.min(Math.max(wc.getZoomLevel() + delta, -5), 5)
    wc.setZoomLevel(level)
    mainWindow?.webContents.send(IPC.browserZoom, Math.round(Math.pow(1.2, level) * 100))
  }
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const key = input.key.toLowerCase()
    if ((key === 't' || key === 'w') && !input.shift) {
      mainWindow?.webContents.send(IPC.browserShortcut, key === 't' ? 'newTab' : 'closeTab')
      e.preventDefault()
      return
    }
    if (input.key === '=' || input.key === '+') zoom(0.5)
    else if (input.key === '-') zoom(-0.5)
    else if (input.key === '0') zoom(null)
    else return
    e.preventDefault()
  })
  wc.on('zoom-changed', (_ev, dir) => zoom(dir === 'in' ? 0.5 : -0.5))
})

app.whenReady().then(async () => {
  // No agents are alive at startup — clear any stale 'running' statuses so the
  // UI shows persisted tabs as resumable.
  await store.markAllStopped()

  registerIpc(() => mainWindow)

  // Loopback server that catches the GitHub/Supabase OAuth redirect.
  startAuthServer((url) => forwardAuthCallback(url))

  // Warm up claude detection so the first tab spawns instantly and we can warn
  // early if the CLI isn't found.
  const caps = await detectClaude()
  if (!caps.helpText) {
    console.warn('[agent-fleet] `claude` CLI not detected — tabs will fail to spawn until it is installed/on PATH.')
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Kill all agent processes when the app closes so none are orphaned.
app.on('before-quit', () => {
  sessionManager.killAll()
  stopAuthServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
