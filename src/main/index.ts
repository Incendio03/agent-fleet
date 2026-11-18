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
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })
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
