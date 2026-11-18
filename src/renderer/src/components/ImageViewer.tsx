import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

/** Full-window viewer for images clicked in a terminal. Esc or backdrop closes. */
export function ImageViewer(): JSX.Element | null {
  const viewer = useStore((s) => s.viewer)
  const close = useStore((s) => s.closeImage)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    setZoomed(false)
    if (!viewer) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, close])

  if (!viewer) return null
  return (
    <div className="image-viewer" onClick={close}>
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="image-viewer-path" title={viewer.path}>{viewer.path}</span>
        <button className="btn sm" onClick={() => void window.fleet.revealImage(viewer.path)}>Show in folder</button>
        <button className="btn sm outline" onClick={close}>Close</button>
      </div>
      <div className={`image-viewer-stage ${zoomed ? 'zoomed' : ''}`}>
        <img
          src={viewer.src}
          alt=""
          title={zoomed ? 'Click to fit' : 'Click for actual size'}
          onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z) }}
        />
      </div>
    </div>
  )
}
