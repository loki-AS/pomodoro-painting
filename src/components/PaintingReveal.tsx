import { useEffect, useRef } from 'react'
import type { Artwork } from '../lib/metApi'
import { loadImage } from '../lib/metApi'
import {
  createStrokeEngine,
  paintToProgress,
  prepareCanvas,
  type StrokeEngine,
} from '../lib/strokeEngine'
import './PaintingReveal.css'

type Props = {
  artwork: Artwork | null
  progress: number
  active: boolean
}

export function PaintingReveal({ artwork, progress, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<StrokeEngine | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const readyForIdRef = useRef<number | null>(null)
  const progressRef = useRef(progress)
  progressRef.current = progress

  useEffect(() => {
    if (!active || !artwork) {
      engineRef.current = null
      ctxRef.current = null
      readyForIdRef.current = null
      return
    }

    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const width = window.innerWidth
    const height = window.innerHeight
    const objectID = artwork.objectID
    const imageUrl = artwork.imageUrl

    const setup = async () => {
      try {
        const img = await loadImage(imageUrl)
        if (cancelled || !canvasRef.current) return

        const ctx = prepareCanvas(canvas, width, height)
        const area = width * height
        const strokeCount = Math.min(1800, Math.max(900, Math.round(area / 2200)))
        const engine = createStrokeEngine(img, width, height, strokeCount)
        engineRef.current = engine
        ctxRef.current = ctx
        readyForIdRef.current = objectID
        paintToProgress(ctx, engine, progressRef.current)
      } catch (err) {
        console.error(err)
      }
    }

    void setup()

    return () => {
      cancelled = true
    }
  }, [active, artwork?.objectID, artwork?.imageUrl])

  useEffect(() => {
    if (!active || !artwork) return
    if (readyForIdRef.current !== artwork.objectID) return
    const engine = engineRef.current
    const ctx = ctxRef.current
    if (!engine || !ctx) return
    paintToProgress(ctx, engine, progress)
  }, [progress, active, artwork])

  return (
    <div className={`painting-reveal ${active ? 'painting-reveal--active' : ''}`}>
      <canvas ref={canvasRef} className="painting-reveal__canvas" />
      <div className="painting-reveal__grain" aria-hidden />
    </div>
  )
}
