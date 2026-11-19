import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { registerIpc, shutdownChats } from './ipc'
import { detectClaude } from './claude'
import { sessionManager } from './sessionManager'
import { startAuthServer, stopAuthServer } from './authServer'
import { parseHook } from './attention'
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
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))

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

// Windows shows the AppUserModelID as the title of notifications. Unregistered
// IDs (dev) are shown verbatim, so use the display name there; a packaged build
// registers this appId with its Start-menu shortcut (keep electron-builder's
// appId in sync). Don't app.setName(): it would move userData (projects/tabs).
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.agentfleet.app' : 'Agent Fleet')
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

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return

  // Pages that open a new window (target=_blank links, window.open) get a tab
  // in the side browser instead. The <webview> needs `allowpopups` for these to
  // reach us at all. We ALLOW a hidden window rather than deny, so window.open()
  // returns a real window — sites often fall back to another URL (e.g. prod)
  // when it returns null — and so "open blank, then set .location" works too.
  // The hidden window's first http(s) URL becomes the tab; then it's destroyed.
  const openTab = (url: string): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserOpenTab, url)
    else void wc.loadURL(url)
  }
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || url === '' || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
        }
      }
    }
    return { action: 'deny' }
  })
  wc.on('did-create-window', (win, details) => {
    let taken = false
    const take = (u?: string): void => {
      if (taken || !u || !/^https?:/i.test(u)) return
      taken = true
      openTab(u)
      if (!win.isDestroyed()) win.destroy()
    }
    take(details.url)
    win.webContents.on('will-navigate', (_ev, u) => take(u))
    win.webContents.on('did-start-navigation', (ev: unknown, u?: string) =>
      take(u ?? (ev as { url?: string } | undefined)?.url)
    )
    // A window that never navigates anywhere useful is cleaned up.
    setTimeout(() => { if (!win.isDestroyed()) win.destroy() }, 15_000)
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
  // (Stale 'running' statuses are cleared whenever a store file is opened; the
  // renderer picks the signed-in account's file via store:setUser.)
  registerIpc(() => mainWindow)

  // Loopback server that catches the GitHub/Supabase OAuth redirect.
  startAuthServer(
    (url) => forwardAuthCallback(url),
    (path, body) => {
      const activity = parseHook(path, body)
      if (!activity || !mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IPC.tabActivity, activity)
      // Flash the taskbar button when an agent wants you and the app isn't focused.
      if (activity.kind !== 'working' && !mainWindow.isFocused()) mainWindow.flashFrame(true)
    }
  )
  ipcMain.on(IPC.windowFocus, () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

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
  shutdownChats()
  stopAuthServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
