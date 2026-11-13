import { useEffect, useRef, useState } from 'react'
import type { Artwork } from '../lib/metApi'
import { loadImage } from '../lib/metApi'
import {
  createStrokeEngine,
  isPaintingComplete,
  paintEndFor,
  prepareCanvas,
  tickPainting,
  type StrokeEngine,
} from '../lib/strokeEngine'
import type { LayerKind } from '../lib/paintPlan'
import './PaintingReveal.css'

/** What the painter is doing right now (null before the brush starts) */
export type PaintStage = LayerKind | 'complete' | null

/** Brief pause on blank gesso after load so the canvas is visible before the brush moves. */
const READY_HOLD_MS = 500

type Props = {
  artwork: Artwork | null
  progress: number
  /** Length of the current phase (used to time the finished-piece preview) */
  durationMs?: number
  /**
   * Length of the break this painting is for: the one in progress, or the one after
   * the current focus session. Lets the painting be planned ahead of time.
   */
  breakMs?: number
  active: boolean
  /** The timer is paused: the brush stops where it is (it doesn't catch up) */
  paused?: boolean
  onReadyChange?: (ready: boolean) => void
  /** Fires true once the last stroke is down (the finished piece is now on show) */
  onCompleteChange?: (complete: boolean) => void
  /** Fires when the painting moves to a new stage (sketch, tone, … , complete) */
  onStageChange?: (stage: PaintStage) => void
}

function remapProgress(progress: number, origin: number): number {
  if (origin >= 0.999) return 1
  return Math.max(0, Math.min(1, (progress - origin) / (1 - origin)))
}

export function PaintingReveal({
  artwork,
  progress,
  durationMs,
  breakMs,
  active,
  paused = false,
  onReadyChange,
  onCompleteChange,
  onStageChange,
}: Props) {
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const durationRef = useRef(durationMs)
  const breakMsRef = useRef(breakMs)
  durationRef.current = durationMs
  breakMsRef.current = breakMs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const weaveRef = useRef<HTMLDivElement>(null)
  /** Planned engine, ready before the break starts; single use */
  const engineRef = useRef<StrokeEngine | null>(null)
  const [plannedId, setPlannedId] = useState<number | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const readyForIdRef = useRef<number | null>(null)
  const originRef = useRef(0)
  const paintAllowedRef = useRef(false)
  const holdUntilRef = useRef(0)
  const progressRef = useRef(progress)
  const onReadyRef = useRef(onReadyChange)
  const onCompleteRef = useRef(onCompleteChange)
  const completeRef = useRef(false)
  const onStageRef = useRef(onStageChange)
  const stageRef = useRef<PaintStage>(null)
  onStageRef.current = onStageChange
  progressRef.current = progress
  onReadyRef.current = onReadyChange
  onCompleteRef.current = onCompleteChange

  const objectID = artwork?.objectID ?? null
  const imageUrl = artwork?.imageUrl ?? null

  // Plan the painting as soon as the artwork is known — normally during the focus
  // session — so the break opens straight onto a ready canvas.
  useEffect(() => {
    engineRef.current = null
    setPlannedId(null)
    if (objectID === null || !imageUrl) return

    let cancelled = false
    const width = window.innerWidth
    const height = window.innerHeight

    const plan = async () => {
      try {
        const img = await loadImage(imageUrl)
        if (cancelled) return
        // Budget strokes for the painting time (break minus the finished-piece preview)
        const seconds = (breakMsRef.current ?? 15 * 60 * 1000) / 1000
        const t0 = performance.now()
        const engine = await createStrokeEngine(img, width, height, seconds * paintEndFor(seconds), () => cancelled)
        if (cancelled || !engine) return
        if (import.meta.env.DEV) {
          const counts = engine.phases.map((p) => `${p.kind}:${p.end - p.start}`).join(' ')
          console.info(
            `[paint] planned ${engine.strokes.length} strokes in ${Math.round(performance.now() - t0)}ms (${counts})`,
          )
        }
        engineRef.current = engine
        setPlannedId(objectID)
      } catch (err) {
        console.error(err)
      }
    }

    void plan()
    return () => {
      cancelled = true
    }
  }, [objectID, imageUrl])

  // When the break is on and the plan is ready, show the canvas and start painting
  useEffect(() => {
    // A new canvas (or no canvas) is never a finished painting
    completeRef.current = false
    onCompleteRef.current?.(false)
    stageRef.current = null
    onStageRef.current?.(null)
    readyForIdRef.current = null
    originRef.current = 0
    paintAllowedRef.current = false
    holdUntilRef.current = 0

    if (!active) {
      ctxRef.current = null
      onReadyRef.current?.(false)
      return
    }

    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas) return
    if (!engine || plannedId === null || plannedId !== objectID) {
      // Still planning: show bare gesso meanwhile
      ctxRef.current = prepareCanvas(canvas, window.innerWidth, window.innerHeight)
      onReadyRef.current?.(false)
      return
    }

    const ctx = prepareCanvas(canvas, engine.width, engine.height)
    ctxRef.current = ctx
    // Canvas-weave shading over the whole picture, composited by the browser for free
    if (weaveRef.current) {
      weaveRef.current.style.backgroundImage = engine.reliefUrl ? `url(${engine.reliefUrl})` : 'none'
    }
    engine.brush.visible = false
    readyForIdRef.current = plannedId
    holdUntilRef.current = performance.now() + READY_HOLD_MS
    tickPainting(ctx, engine, 0, 16)
    onReadyRef.current?.(true)
  }, [active, plannedId, objectID])

  useEffect(() => {
    if (!active) return

    let raf = 0
    let last = performance.now()

    const frame = (now: number) => {
      const engine = engineRef.current
      const ctx = ctxRef.current
      const ready = objectID !== null && !!engine && !!ctx && readyForIdRef.current === objectID

      if (ready) {
        // Paused: no time passes for the hand, so it holds still mid-stroke
        const dt = pausedRef.current ? 0 : Math.min(50, now - last)
        last = now

        if (!paintAllowedRef.current) {
          if (now >= holdUntilRef.current) {
            // Start the painting clock only after canvas has been shown blank
            originRef.current = progressRef.current
            paintAllowedRef.current = true
            // Finish early enough that the completed piece is on show for a while
            const seconds = (durationRef.current ?? 0) / 1000
            engine.paintEnd = paintEndFor(seconds * (1 - originRef.current))
          } else {
            tickPainting(ctx, engine, 0, dt)
            raf = requestAnimationFrame(frame)
            return
          }
        }

        const mapped = remapProgress(progressRef.current, originRef.current)
        tickPainting(ctx, engine, mapped, dt)
        const done = isPaintingComplete(engine)
        if (done !== completeRef.current) {
          completeRef.current = done
          onCompleteRef.current?.(done)
        }
        const stage: PaintStage = done ? 'complete' : (engine.strokes[engine.hand.next]?.kind ?? null)
        if (stage !== stageRef.current) {
          stageRef.current = stage
          onStageRef.current?.(stage)
        }
      } else {
        last = now
      }
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active, objectID])

  return (
    <div className={`painting-reveal ${active ? 'painting-reveal--active' : ''}`}>
      <canvas ref={canvasRef} className="painting-reveal__canvas" />
      <div ref={weaveRef} className="painting-reveal__weave" aria-hidden />
      <div className="painting-reveal__grain" aria-hidden />
    </div>
  )
}
