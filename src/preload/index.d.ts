import type { FleetApi } from './index'

// Makes `window.fleet` fully typed everywhere in the renderer.
declare global {
  interface Window {
    fleet: FleetApi
  }
}

export {}
