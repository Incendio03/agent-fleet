import { useEffect, useState } from 'react'

const MIN_MS = 900 // keep it up long enough to read as a splash, not a flicker
const FADE_MS = 400

/**
 * Full-window startup splash. Covers the whole app until `done`, then fades
 * out and unmounts.
 */
export function SplashScreen({ done }: { done: boolean }): JSX.Element | null {
  const [minPassed, setMinPassed] = useState(false)
  const [fading, setFading] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setMinPassed(true), MIN_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!done || !minPassed) return
    setFading(true)
    const t = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(t)
  }, [done, minPassed])

  if (gone) return null
  return (
    <div className={`splash ${fading ? 'fading' : ''}`}>
      <div className="splash-logo">⚓</div>
      <div className="splash-name">Agent Fleet</div>
      <div className="splash-bar"><span /></div>
      <div className="splash-version">v{__APP_VERSION__}</div>
    </div>
  )
}
