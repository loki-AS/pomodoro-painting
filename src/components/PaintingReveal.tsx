import { useEffect, useRef } from 'react'
import type { Artwork } from '../lib/metApi'
import { loadImage } from '../lib/metApi'
import {
  createStrokeEngine,
  prepareCanvas,
  tickPainting,
  type StrokeEngine,
} from '../lib/strokeEngine'
import './PaintingReveal.css'

/** Brief pause on blank gesso after load so the canvas is visible before the brush moves. */
const READY_HOLD_MS = 500

type Props = {
  artwork: Artwork | null
  progress: number
  active: boolean
  onReadyChange?: (ready: boolean) => void
}

function remapProgress(progress: number, origin: number): number {
  if (origin >= 0.999) return 1
  return Math.max(0, Math.min(1, (progress - origin) / (1 - origin)))
}

export function PaintingReveal({
  artwork,
  progress,
  active,
  onReadyChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<StrokeEngine | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const readyForIdRef = useRef<number | null>(null)
  const originRef = useRef(0)
  const paintAllowedRef = useRef(false)
  const holdUntilRef = useRef(0)
  const progressRef = useRef(progress)
  const onReadyRef = useRef(onReadyChange)
  progressRef.current = progress
  onReadyRef.current = onReadyChange

  useEffect(() => {
    if (!active) {
      engineRef.current = null
      ctxRef.current = null
      readyForIdRef.current = null
      originRef.current = 0
      paintAllowedRef.current = false
      holdUntilRef.current = 0
      onReadyRef.current?.(false)
      return
    }

    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const width = window.innerWidth
    const height = window.innerHeight
    const ctx = prepareCanvas(canvas, width, height)
    ctxRef.current = ctx
    engineRef.current = null
    readyForIdRef.current = null
    paintAllowedRef.current = false
    holdUntilRef.current = 0
    onReadyRef.current?.(false)

    if (!artwork) return

    const objectID = artwork.objectID
    const imageUrl = artwork.imageUrl

    const setup = async () => {
      try {
        const img = await loadImage(imageUrl)
        if (cancelled || !canvasRef.current) return

        const area = width * height
        const strokeCount = Math.min(1100, Math.max(600, Math.round(area / 3200)))
        const engine = createStrokeEngine(img, width, height, strokeCount)
        if (cancelled) return

        // Canvas is loaded — show blank gesso first; brush waits for hold
        engine.brush.visible = false
        engineRef.current = engine
        readyForIdRef.current = objectID
        paintAllowedRef.current = false
        holdUntilRef.current = performance.now() + READY_HOLD_MS
        tickPainting(ctx, engine, 0, 16)
        onReadyRef.current?.(true)
      } catch (err) {
        console.error(err)
        onReadyRef.current?.(false)
      }
    }

    void setup()

    return () => {
      cancelled = true
      onReadyRef.current?.(false)
    }
  }, [active, artwork?.objectID, artwork?.imageUrl])

  useEffect(() => {
    if (!active) return

    let raf = 0
    let last = performance.now()

    const frame = (now: number) => {
      const engine = engineRef.current
      const ctx = ctxRef.current
      const ready =
        !!artwork &&
        !!engine &&
        !!ctx &&
        readyForIdRef.current === artwork.objectID

      if (ready) {
        const dt = Math.min(50, now - last)
        last = now

        if (!paintAllowedRef.current) {
          if (now >= holdUntilRef.current) {
            // Start the painting clock only after canvas has been shown blank
            originRef.current = progressRef.current
            paintAllowedRef.current = true
          } else {
            tickPainting(ctx, engine, 0, dt)
            raf = requestAnimationFrame(frame)
            return
          }
        }

        const mapped = remapProgress(progressRef.current, originRef.current)
        tickPainting(ctx, engine, mapped, dt)
      } else {
        last = now
      }
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active, artwork])

  return (
    <div className={`painting-reveal ${active ? 'painting-reveal--active' : ''}`}>
      <canvas ref={canvasRef} className="painting-reveal__canvas" />
      <div className="painting-reveal__grain" aria-hidden />
    </div>
  )
}
