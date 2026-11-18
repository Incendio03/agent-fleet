import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { detectClaude } from './claude'
import { sessionManager } from './sessionManager'
import { IPC } from '@shared/types'

let mainWindow: BrowserWindow | null = null

// Custom URL scheme used as the OAuth redirect target: agentfleet://auth?code=...
const PROTOCOL = 'agentfleet'

/** Pull an agentfleet:// callback URL out of argv/args and hand it to the UI. */
function forwardAuthCallback(url: string | undefined): void {
  if (url && url.startsWith(`${PROTOCOL}://`)) {
    mainWindow?.webContents.send(IPC.authCallback, url)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
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
      nodeIntegration: false
    }
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

// Only one instance may run, so OAuth deep-links always reach the live window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Windows/Linux: the deep link arrives as an argv on the second instance.
  app.on('second-instance', (_e, argv) => {
    forwardAuthCallback(argv.find((a) => a.startsWith(`${PROTOCOL}://`)))
  })
  // macOS: the deep link arrives via open-url.
  app.on('open-url', (_e, url) => forwardAuthCallback(url))
}

// Register as the handler for agentfleet:// links.
if (process.defaultApp && process.argv.length >= 2) {
  // dev mode: must pass the script path so Windows re-launches us correctly
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [join(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

app.whenReady().then(async () => {
  registerIpc(() => mainWindow)

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
app.on('before-quit', () => sessionManager.killAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
