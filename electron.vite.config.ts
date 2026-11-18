import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the app version: package.json. Injected at build
// time as the global __APP_VERSION__ so both the main process and the UI can
// show/report it without reading package.json at runtime.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const versionDefine = { __APP_VERSION__: JSON.stringify(pkg.version) }

// electron-vite splits the app into three builds:
//   main     -> Electron main process (our backend: node-pty, git, Supabase admin)
//   preload  -> the secure bridge exposed to the renderer
//   renderer -> the React UI (runs in a sandboxed browser window)
export default defineConfig({
  main: {
    // Native/node deps (node-pty, etc.) must stay external — never bundled.
    plugins: [externalizeDepsPlugin()],
    define: versionDefine,
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: versionDefine,
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
