import {
  MID_GREY,
  clamp,
  downSec,
  lerp,
  liftSec,
  planPainting,
  rand,
  randInt,
  smoothstep,
  strokeSec,
  targetIndex,
  travelSec,
  type LayerKind,
  type Phase,
  type RGB,
  type Stroke,
} from './paintPlan'

export type { Stroke } from './paintPlan'

export type BrushPose = {
  x: number
  y: number
  /** Screen direction the handle points, from the tip toward the hand */
  angle: number
  color: string
  tipWidth: number
  /** 0 = tip on the canvas, 1 = well above it */
  lift: number
  visible: boolean
  /** The sketch is drawn with a pencil, everything after with brushes */
  tool: 'pencil' | 'brush'
}

type HandPhase = 'idle' | 'travel' | 'down' | 'stroke' | 'lift' | 'reload'

type Hand = {
  phase: HandPhase
  /** Seconds elapsed in the current phase (hand time) */
  t: number
  dur: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  liftFrom: number
  /** Index of the stroke being painted / next to paint (= completed strokes) */
  next: number
  untilReload: number
  /** Estimated strokes/sec the timer is asking for */
  rate: number
  lastTarget: number
  /** Running average of a stroke cycle's natural duration (sec) */
  avgCycle: number
  cycleAcc: number
  speed: number
  targetAngle: number
  started: boolean
  clock: number
  /** Layer of the previous stroke: switching layers means changing tools */
  lastKind: LayerKind | null
}

export type StrokeEngine = {
  strokes: Stroke[]
  phases: Phase[]
  /** The image blurred to each paint layer's scale; strokes carry these */
  refs: HTMLCanvasElement[]
  paintLayer: HTMLCanvasElement
  paintCtx: CanvasRenderingContext2D
  /**
   * The stroke in progress is drawn opaque here and laid onto paintLayer once,
   * at the stroke's alpha, so overlapping dabs/segments never double up.
   */
  strokeLayer: HTMLCanvasElement
  strokeCtx: CanvasRenderingContext2D
  activeStroke: Stroke | null
  /** The wet stroke, fully composed (reference, streaks, tint, dry-brush), built up piece by piece */
  scratch: HTMLCanvasElement
  scratchCtx: CanvasRenderingContext2D
  /** Alpha mask of canvas-weave peaks (dry paint skips these) */
  weave: CanvasPattern | null
  /** Scratch for the paint-ridge silhouettes */
  shade: HTMLCanvasElement
  shadeCtx: CanvasRenderingContext2D
  /** Canvas-weave shading tile as a data URL, laid over the picture with CSS */
  reliefUrl: string | null
  width: number
  height: number
  brush: BrushPose
  hand: Hand
  /** Last point index committed on the active stroke */
  pathCursor: number
  /** Painting progress (0..1) by which every stroke is done; the rest is a preview */
  paintEnd: number
}

export const GESSO = '#e8dfd0'

/** Resting handle direction for a right-handed painter: tip upper-left, handle lower-right. */
const REST_ANGLE = 0.8

function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Minimum-jerk profile: how human reaching movements accelerate and settle. */
function minJerk(u: number): number {
  const t = clamp(u, 0, 1)
  return t * t * t * (10 - 15 * t + 6 * t * t)
}

/** Bell-shaped stroke speed that never fully stalls (paint keeps flowing). */
function strokeEase(u: number): number {
  return 0.3 * u + 0.7 * minJerk(u)
}

/**
 * Procedural plain-weave linen tile. `mask` is opaque on thread crowns (where a dry
 * brush leaves no paint); `shade` darkens the hollows between threads very slightly.
 */
function makeWeaveTiles(): { mask: HTMLCanvasElement; shade: HTMLCanvasElement } | null {
  const size = 96
  const period = 4
  const mask = document.createElement('canvas')
  const shade = document.createElement('canvas')
  mask.width = mask.height = shade.width = shade.height = size
  const mctx = mask.getContext('2d')
  const sctx = shade.getContext('2d')
  if (!mctx || !sctx) return null

  // Wrapping value noise so thread thickness and tension vary like real linen
  const g = 6
  const cell = size / g
  const grid = Array.from({ length: g * g }, () => Math.random())
  const noise = (x: number, y: number) => {
    const gx = x / cell
    const gy = y / cell
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const at = (i: number, j: number) => grid[((j % g) + g) % g * g + (((i % g) + g) % g)]!
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), sx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx), sy)
  }

  const mImg = mctx.createImageData(size, size)
  const sImg = sctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / period)
      const weft = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / period)
      // Plain weave: warp and weft take turns lying on top
      const over = (Math.floor(x / period) + Math.floor(y / period)) % 2 === 0
      const crown = over ? warp * 0.75 + weft * 0.25 : weft * 0.75 + warp * 0.25
      const n = noise(x, y)
      // Paint skips in irregular patches (where the brush rode high), not uniformly
      const v = crown * 0.55 + n * 0.45 + (Math.random() - 0.5) * 0.14
      const i = (y * size + x) * 4
      mImg.data[i + 3] = smoothstep(0.66, 0.97, v) * 255
      // Thread hollows, unevenly deep, so the grain reads as linen rather than a grid
      sImg.data[i + 3] = (1 - crown) * (0.025 + 0.035 * n + Math.random() * 0.012) * 255
    }
  }
  mctx.putImageData(mImg, 0, 0)
  sctx.putImageData(sImg, 0, 0)
  return { mask, shade }
}


/**
 * Build the engine: fit the image to the screen, plan the whole painting (sketch
 * through detail), and prepare the layers the hand paints into.
 */
export async function createStrokeEngine(
  image: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number,
  breakSeconds = 15 * 60,
  cancelled: () => boolean = () => false,
): Promise<StrokeEngine | null> {
  const source = document.createElement('canvas')
  source.width = canvasWidth
  source.height = canvasHeight
  const sctx = source.getContext('2d')
  if (!sctx) throw new Error('Could not create source canvas')

  const scale = Math.max(canvasWidth / image.naturalWidth, canvasHeight / image.naturalHeight)
  const dw = image.naturalWidth * scale
  const dh = image.naturalHeight * scale
  sctx.fillStyle = GESSO
  sctx.fillRect(0, 0, canvasWidth, canvasHeight)
  sctx.drawImage(image, (canvasWidth - dw) / 2, (canvasHeight - dh) / 2, dw, dh)

  const plan = await planPainting(source, canvasWidth, canvasHeight, breakSeconds, cancelled)
  if (!plan) return null

  const layer = (opts?: CanvasRenderingContext2DSettings) => {
    const c = document.createElement('canvas')
    c.width = canvasWidth
    c.height = canvasHeight
    const ctx = c.getContext('2d', opts)
    if (!ctx) throw new Error('Could not create canvas layer')
    return [c, ctx] as const
  }

  const [paintLayer, paintCtx] = layer()
  paintCtx.fillStyle = GESSO
  paintCtx.fillRect(0, 0, canvasWidth, canvasHeight)
  const [strokeLayer, strokeCtx] = layer()
  const [scratch, scratchCtx] = layer()
  const [shade, shadeCtx] = layer()

  const weaveTiles = makeWeaveTiles()
  const weave = weaveTiles ? strokeCtx.createPattern(weaveTiles.mask, 'repeat') : null
  const reliefUrl = weaveTiles ? weaveTiles.shade.toDataURL() : null

  return {
    strokes: plan.strokes,
    phases: plan.phases,
    refs: plan.refs,
    paintLayer,
    paintCtx,
    strokeLayer,
    strokeCtx,
    activeStroke: null,
    scratch,
    scratchCtx,
    weave,
    shade,
    shadeCtx,
    reliefUrl,
    width: canvasWidth,
    height: canvasHeight,
    pathCursor: 0,
    paintEnd: 0.94,
    brush: {
      // The hand enters from off-canvas, lower right, where it rests
      x: canvasWidth * 0.95,
      y: canvasHeight * 1.1,
      angle: REST_ANGLE,
      color: '#3e3832',
      tipWidth: 18,
      lift: 1,
      visible: false,
      tool: 'pencil',
    },
    hand: {
      phase: 'idle',
      t: 0,
      dur: 0,
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      liftFrom: 1,
      next: 0,
      untilReload: randInt(5, 9),
      rate: 0,
      lastTarget: 0,
      avgCycle: 0.4,
      cycleAcc: 0,
      speed: 1,
      targetAngle: REST_ANGLE,
      started: false,
      clock: 0,
      lastKind: null,
    },
  }
}

/**
 * Flat-brush pressure: bristles splay to full width right after touchdown, hold,
 * then narrow a little as the brush lifts (not a lemon-shaped sine swell).
 */
function strokeWidthAt(stroke: Stroke, i: number): number {
  const t = stroke.cum[i]! / stroke.length
  const press = stroke.style === 'dab' ? 1 : 0.62 + 0.38 * smoothstep(0, 0.14, t)
  const lift = 1 - 0.32 * smoothstep(0.74, 1, t)
  return Math.max(1.2, stroke.baseWidth * press * lift)
}

function strokeAngleAt(stroke: Stroke, index: number): number {
  const pts = stroke.points
  if (pts.length < 2) return -Math.PI / 4
  const i0 = clamp(index, 0, pts.length - 2)
  const a = pts[i0]!
  const b = pts[i0 + 1]!
  return Math.atan2(b.y - a.y, b.x - a.x)
}

/**
 * The handle doesn't flip around with stroke direction: the wrist stays roughly put
 * and the handle only leans toward whichever way the bristles are dragged.
 */
function handleAngleFor(strokeDir: number, clock: number): number {
  const rest = REST_ANGLE + Math.sin(clock * 0.31) * 0.12
  const trailing = strokeDir + Math.PI
  const pick =
    Math.abs(angleDiff(rest, trailing)) < Math.abs(angleDiff(rest, strokeDir)) ? trailing : strokeDir
  return rest + angleDiff(rest, pick) * 0.38
}

/** Point at arc length `s` along the stroke, plus the index of the segment it falls in. */
function pointAt(stroke: Stroke, s: number): { x: number; y: number; i: number } {
  const { points, cum } = stroke
  if (s <= 0) return { ...points[0]!, i: 0 }
  if (s >= stroke.length) return { ...points[points.length - 1]!, i: points.length - 1 }
  let i = 1
  while (i < cum.length - 1 && cum[i]! < s) i++
  const a = points[i - 1]!
  const b = points[i]!
  const seg = cum[i]! - cum[i - 1]!
  const f = seg > 0 ? (s - cum[i - 1]!) / seg : 0
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), i: i - 1 }
}

/**
 * Fill one ribbon quad between points i0 and i1, offset sideways by `off` (fraction
 * of brush width) with thickness `thick` (fraction of brush width). Using per-point
 * normals and widths keeps neighbouring quads seamless, so edges stay smooth instead
 * of scalloped. The quad reaches back a hair so anti-aliased seams never show.
 */
function ribbonQuad(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  i0: number,
  i1: number,
  off: number,
  thick: number,
): void {
  const p0 = stroke.points[i0]!
  const p1 = stroke.points[i1]!
  const n0 = stroke.normals[i0]!
  const n1 = stroke.normals[i1]!
  const w0 = strokeWidthAt(stroke, i0)
  const w1 = strokeWidthAt(stroke, i1)
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1
  const bx = (-dx / len) * 0.75
  const by = (-dy / len) * 0.75
  const c0 = off * w0
  const c1 = off * w1
  const h0 = (thick * w0) / 2
  const h1 = (thick * w1) / 2
  ctx.beginPath()
  ctx.moveTo(p0.x + bx + n0.x * (c0 - h0), p0.y + by + n0.y * (c0 - h0))
  ctx.lineTo(p0.x + bx + n0.x * (c0 + h0), p0.y + by + n0.y * (c0 + h0))
  ctx.lineTo(p1.x + n1.x * (c1 + h1), p1.y + n1.y * (c1 + h1))
  ctx.lineTo(p1.x + n1.x * (c1 - h1), p1.y + n1.y * (c1 - h1))
  ctx.closePath()
  ctx.fill()
}

/** Rounded end where the brush meets or leaves the canvas. */
function endCap(ctx: CanvasRenderingContext2D, stroke: Stroke, i: number, thick: number): void {
  const p = stroke.points[i]!
  const n = stroke.normals[i]!
  const w = strokeWidthAt(stroke, i) * thick
  ctx.beginPath()
  // Flat brush: wide across the stroke, short along it
  ctx.ellipse(p.x, p.y, w * 0.5, w * 0.22, Math.atan2(n.y, n.x), 0, Math.PI * 2)
  ctx.fill()
}

/** Paint one path segment between two points, opaque, onto the stroke layer. */
function paintSegment(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  i0: number,
  i1: number,
): void {
  const pts = stroke.points
  if (i0 < 0 || i1 >= pts.length || i1 <= i0) return
  const last = i1 === pts.length - 1
  const t1 = stroke.cum[i1]! / stroke.length

  const tMid = (stroke.cum[i0]! + stroke.cum[i1]!) / 2 / stroke.length

  ctx.save()
  ctx.fillStyle = wetColor(stroke, stroke.level >= 0 ? MID_GREY : stroke.rgb, tMid)

  if (stroke.style === 'bristle') {
    // Parallel hair tracks, each its own shade; some run dry before the end
    const hairs = stroke.hairRgb.length
    const tNext = last ? Infinity : stroke.cum[i1 + 1]! / stroke.length
    for (let h = 0; h < hairs; h++) {
      if (t1 > stroke.hairEnd[h]!) continue
      ctx.fillStyle = wetColor(stroke, stroke.hairRgb[h]!, tMid)
      const off = (h - (hairs - 1) / 2) / hairs
      ribbonQuad(ctx, stroke, i0, i1, off, stroke.hairFill / hairs)
      // This hair's last segment: round its tip so the stroke frays, not steps
      if (tNext > stroke.hairEnd[h]!) {
        const p = pts[i1]!
        const n = stroke.normals[i1]!
        const w = strokeWidthAt(stroke, i1)
        const hw = (w * stroke.hairFill) / hairs
        ctx.beginPath()
        ctx.ellipse(p.x + n.x * off * w, p.y + n.y * off * w, hw * 0.5, hw * 0.9, Math.atan2(n.y, n.x), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else {
    const thick = stroke.style === 'edge' ? 0.85 : 1
    ribbonQuad(ctx, stroke, i0, i1, 0, thick)
    if (last) endCap(ctx, stroke, i1, thick)
  }
  ctx.restore()
}

/**
 * Wet-on-wet: at touchdown the brush carries some of the paint it landed in.
 * That mix is strongest at the start and clears as fresh paint flows from the brush.
 */
function wetColor(stroke: Stroke, base: RGB, t: number): string {
  const p = stroke.pickup
  // Paint strokes draw grey streak values on the stroke layer (their colour comes
  // from the painterly reference), so only flat strokes mix in picked-up paint
  if (!p || stroke.mix <= 0 || stroke.level >= 0) return `rgb(${base[0]}, ${base[1]}, ${base[2]})`
  const f = stroke.mix * (1 - smoothstep(0, 0.6, t))
  return `rgb(${lerp(base[0], p[0], f) | 0}, ${lerp(base[1], p[1], f) | 0}, ${lerp(base[2], p[2], f) | 0})`
}



/** Loaded tip touching the canvas at the start of a stroke. */
function dropBlotch(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  ctx.save()
  ctx.fillStyle = wetColor(stroke, stroke.level >= 0 ? MID_GREY : stroke.rgb, 0)
  endCap(ctx, stroke, 0, stroke.style === 'edge' ? 0.85 : 1)
  ctx.restore()
}

/** Brush touches down: start a fresh stroke layer with the loaded-tip blotch. */
function beginStrokePaint(engine: StrokeEngine, stroke: Stroke): void {
  const { x, y, w, h } = stroke.bbox
  engine.strokeCtx.clearRect(x, y, w, h)
  engine.scratchCtx.clearRect(x, y, w, h)
  engine.activeStroke = stroke
  engine.pathCursor = 0
  dropBlotch(engine.strokeCtx, stroke)
  composeArea(engine, stroke, 0, 0)
}

/**
 * Compose the finished look of the wet stroke (painterly reference through the
 * brush mask, bristle streaks, the brush's own tint, dry-brush weave) into the
 * scratch layer — but only around points i0..i1, the part just painted. Every step
 * is per-pixel, so composing piece by piece gives exactly the full-stroke result
 * while keeping each frame cheap.
 */
function composeArea(engine: StrokeEngine, stroke: Stroke, i0: number, i1: number): void {
  const pad = stroke.baseWidth * 0.75 + 4
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = Math.max(0, i0); i <= Math.min(stroke.points.length - 1, i1); i++) {
    const p = stroke.points[i]!
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  const b = stroke.bbox
  const x = Math.max(b.x, Math.floor(x0 - pad))
  const y = Math.max(b.y, Math.floor(y0 - pad))
  const w = Math.min(b.x + b.w, Math.ceil(x1 + pad)) - x
  const h = Math.min(b.y + b.h, Math.ceil(y1 + pad)) - y
  if (w <= 0 || h <= 0) return

  const ref = stroke.level >= 0 ? engine.refs[stroke.level] : undefined
  const sc = engine.scratchCtx
  sc.save()
  // Clip to this piece: modes like destination-in otherwise wipe the whole canvas
  // outside the drawn image, erasing the parts of the stroke composed earlier
  sc.beginPath()
  sc.rect(x, y, w, h)
  sc.clip()
  sc.clearRect(x, y, w, h)
  if (ref) {
    // The stroke carries the painterly image at this stage's brush scale...
    sc.drawImage(ref, x, y, w, h, x, y, w, h)
    sc.globalCompositeOperation = 'destination-in'
    sc.drawImage(engine.strokeLayer, x, y, w, h, x, y, w, h)
    // ...with bristle streaks dragged along it (grey hairs as soft light)...
    if (stroke.streak > 0) {
      sc.globalCompositeOperation = 'soft-light'
      sc.globalAlpha = stroke.streak
      sc.drawImage(engine.strokeLayer, x, y, w, h, x, y, w, h)
    }
    // ...and a little of the brush's own load, mixed with any wet paint it picked up
    if (stroke.tint > 0) {
      sc.globalCompositeOperation = 'source-atop'
      sc.globalAlpha = stroke.tint
      const p = stroke.pickup
      const f = p ? stroke.mix : 0
      sc.fillStyle = p
        ? `rgb(${lerp(stroke.rgb[0], p[0], f) | 0}, ${lerp(stroke.rgb[1], p[1], f) | 0}, ${lerp(stroke.rgb[2], p[2], f) | 0})`
        : stroke.color
      sc.fillRect(x, y, w, h)
    }
  } else {
    sc.drawImage(engine.strokeLayer, x, y, w, h, x, y, w, h)
  }
  if (stroke.dry > 0 && engine.weave) {
    sc.globalCompositeOperation = 'destination-out'
    sc.globalAlpha = stroke.dry
    sc.fillStyle = engine.weave
    sc.fillRect(x, y, w, h)
  }
  sc.restore()
}

/**
 * Lay a stroke from the stroke layer onto `target`: knock out canvas-weave peaks
 * for dry-brush texture, then cast a thin shadow and highlight so the paint reads
 * as a raised ridge (impasto), then the paint itself.
 */
function renderStroke(
  target: CanvasRenderingContext2D,
  engine: StrokeEngine,
  stroke: Stroke,
  withRidge = true,
): void {
  const { x, y, w, h } = stroke.bbox
  // The scratch layer already holds this stroke fully composed (see composeArea)
  const src = engine.scratch

  target.save()
  // Thin washes and tiny touches barely stand proud of the canvas; loaded strokes do
  const body = (stroke.style === 'wash' ? 0.35 : 1) * clamp(stroke.baseWidth / 16, 0.35, 1) * stroke.relief
  if (withRidge && body > 0.01 && stroke.style !== 'pencil') {
    // Paint ridge: a dark silhouette offset down-right and a light one up-left,
    // made by compositing (much cheaper than ctx.filter). Whole-pixel offsets:
    // fractional ones resample past the bounds and show as faint straight lines.
    const off = stroke.baseWidth > 30 ? 2 : 1
    const sh = engine.shadeCtx
    sh.save()
    sh.clearRect(x, y, w, h)
    sh.drawImage(src, x, y, w, h, x, y, w, h)
    sh.globalCompositeOperation = 'source-in'
    sh.fillStyle = '#000'
    sh.fillRect(x, y, w, h)
    target.globalAlpha = 0.11 * body * stroke.alpha
    target.drawImage(engine.shade, x, y, w, h, x + off, y + off, w, h)
    sh.fillStyle = '#fff'
    sh.fillRect(x, y, w, h)
    target.globalAlpha = 0.08 * body * stroke.alpha
    target.drawImage(engine.shade, x, y, w, h, x - 1, y - 1, w, h)
    sh.restore()
    sh.clearRect(x, y, w, h)
  }
  target.globalAlpha = stroke.alpha
  target.drawImage(src, x, y, w, h, x, y, w, h)
  target.restore()
}

function commitTo(engine: StrokeEngine, stroke: Stroke, idx: number): void {
  const from = engine.pathCursor
  if (idx <= from) return
  for (let i = from + 1; i <= idx; i++) {
    paintSegment(engine.strokeCtx, stroke, i - 1, i)
  }
  engine.pathCursor = idx
  composeArea(engine, stroke, from, idx)
}

/** Brush lifts: lay the finished stroke onto the canvas at its opacity. */
function endStrokePaint(engine: StrokeEngine): void {
  const stroke = engine.activeStroke
  if (!stroke) return
  const { x, y, w, h } = stroke.bbox
  renderStroke(engine.paintCtx, engine, stroke)
  engine.strokeCtx.clearRect(x, y, w, h)
  engine.scratchCtx.clearRect(x, y, w, h)
  engine.activeStroke = null
  engine.pathCursor = 0
}

function paintWholeStroke(engine: StrokeEngine, stroke: Stroke): void {
  beginStrokePaint(engine, stroke)
  commitTo(engine, stroke, stroke.points.length - 1)
  endStrokePaint(engine)
}

// ---------------------------------------------------------------------------
// Hand: a small state machine that moves the brush like a person would —
// travel above the canvas, press down, drag with a bell-shaped speed, lift,
// and occasionally pause to reload paint.
// ---------------------------------------------------------------------------



function approachPoint(stroke: Stroke): { x: number; y: number } {
  const p0 = stroke.points[0]!
  const a = strokeAngleAt(stroke, 0)
  const back = Math.min(14, stroke.baseWidth * 0.35 + 4)
  return { x: p0.x - Math.cos(a) * back, y: p0.y - Math.sin(a) * back }
}

function setPhase(h: Hand, phase: HandPhase, dur: number): void {
  h.phase = phase
  h.t = 0
  h.dur = dur
}

function beginNext(engine: StrokeEngine, target: number): void {
  const h = engine.hand
  const b = engine.brush
  h.fromX = b.x
  h.fromY = b.y
  h.liftFrom = b.lift

  if (h.next >= engine.strokes.length || h.next >= target) {
    setPhase(h, 'idle', Infinity)
    return
  }

  const stroke = engine.strokes[h.next]!

  // Moving to the next stage: step back, put down the pencil / change brush
  if (h.started && h.lastKind !== stroke.kind) {
    h.lastKind = stroke.kind
    h.untilReload = randInt(5, 9)
    setPhase(h, 'reload', rand(0.9, 1.4))
    return
  }
  h.lastKind = stroke.kind

  // Pause to reload paint only when there's time to spare
  if (stroke.style !== 'pencil' && h.untilReload <= 0 && h.speed < 1.3 && h.started) {
    h.untilReload = randInt(5, 9)
    setPhase(h, 'reload', rand(0.45, 0.9))
    return
  }

  const ap = approachPoint(stroke)
  h.toX = ap.x
  h.toY = ap.y
  const dist = Math.hypot(ap.x - b.x, ap.y - b.y)
  const dur = travelSec(dist, stroke)
  h.cycleAcc = dur + downSec(stroke) + strokeSec(stroke) + liftSec(stroke)
  h.targetAngle = handleAngleFor(strokeAngleAt(stroke, 0), h.clock)
  b.tool = stroke.style === 'pencil' ? 'pencil' : 'brush'
  b.color = stroke.color
  b.tipWidth = clamp(stroke.baseWidth * 0.55, 3, 42)
  h.started = true
  b.visible = true
  setPhase(h, 'travel', dur)
}

function updatePhase(engine: StrokeEngine): void {
  const h = engine.hand
  const b = engine.brush
  const u = h.dur > 0 && Number.isFinite(h.dur) ? clamp(h.t / h.dur, 0, 1) : 1
  const stroke = engine.strokes[h.next]

  switch (h.phase) {
    case 'travel': {
      const e = minJerk(u)
      const dx = h.toX - h.fromX
      const dy = h.toY - h.fromY
      const dist = Math.hypot(dx, dy)
      // Slight arc, as a wrist sweeps rather than slides in a straight line
      const bulge = Math.sin(u * Math.PI) * Math.min(40, dist * 0.08)
      const nx = dist > 0 ? -dy / dist : 0
      const ny = dist > 0 ? dx / dist : 0
      b.x = h.fromX + dx * e + nx * bulge
      b.y = h.fromY + dy * e + ny * bulge
      b.lift = lerp(h.liftFrom, 0.12, e) + Math.sin(u * Math.PI) * Math.min(0.55, dist / 450)
      break
    }
    case 'down': {
      if (!stroke) break
      const p0 = stroke.points[0]!
      const e = minJerk(u)
      b.x = lerp(h.fromX, p0.x, e)
      b.y = lerp(h.fromY, p0.y, e)
      b.lift = lerp(0.12, 0, e)
      break
    }
    case 'stroke': {
      if (!stroke) break
      const s = strokeEase(u) * stroke.length
      const p = pointAt(stroke, s)
      commitTo(engine, stroke, p.i)
      b.x = p.x
      b.y = p.y
      b.lift = 0
      h.targetAngle = handleAngleFor(strokeAngleAt(stroke, p.i), h.clock)
      break
    }
    case 'lift': {
      // Follow-through: the brush keeps moving a little as it leaves the canvas
      const e = minJerk(u)
      b.x = lerp(h.fromX, h.toX, e)
      b.y = lerp(h.fromY, h.toY, e)
      b.lift = lerp(0, 0.3, e)
      break
    }
    case 'reload': {
      b.lift = lerp(h.liftFrom, 0.95, minJerk(Math.min(1, u * 2.5)))
      break
    }
    case 'idle':
      break
  }
}

function finishPhase(engine: StrokeEngine, target: number): void {
  const h = engine.hand
  const b = engine.brush
  const stroke = engine.strokes[h.next]

  switch (h.phase) {
    case 'travel':
      h.fromX = b.x
      h.fromY = b.y
      setPhase(h, 'down', stroke ? downSec(stroke) : 0.05)
      break
    case 'down':
      if (stroke) beginStrokePaint(engine, stroke)
      setPhase(h, 'stroke', stroke ? strokeSec(stroke) : 0)
      break
    case 'stroke': {
      if (stroke) {
        commitTo(engine, stroke, stroke.points.length - 1)
        endStrokePaint(engine)
        const a = strokeAngleAt(stroke, stroke.points.length - 2)
        const flick = Math.min(16, 6 + stroke.baseWidth * 0.2)
        h.fromX = b.x
        h.fromY = b.y
        h.toX = b.x + Math.cos(a) * flick
        h.toY = b.y + Math.sin(a) * flick
      }
      engine.pathCursor = 0
      h.next++
      h.untilReload--
      h.avgCycle += (h.cycleAcc - h.avgCycle) * 0.08
      setPhase(h, 'lift', stroke ? liftSec(stroke) : 0.08)
      break
    }
    case 'lift':
    case 'reload':
      beginNext(engine, target)
      break
    case 'idle':
      break
  }
}

/** Instantly paint strokes so the hand never falls hopelessly behind (tab switch, seek). */
function skipAhead(engine: StrokeEngine, upTo: number): void {
  const h = engine.hand
  if (h.next >= upTo) return
  const current = engine.strokes[h.next]
  if (current && (h.phase === 'stroke' || h.phase === 'down')) {
    if (h.phase === 'down') beginStrokePaint(engine, current)
    commitTo(engine, current, current.points.length - 1)
    endStrokePaint(engine)
    h.next++
  }
  while (h.next < upTo) {
    paintWholeStroke(engine, engine.strokes[h.next]!)
    h.next++
  }
  const last = engine.strokes[h.next - 1]
  if (last) {
    const p = last.points[last.points.length - 1]!
    engine.brush.x = p.x
    engine.brush.y = p.y
    engine.brush.lift = 0.3
  }
  setPhase(h, 'idle', Infinity)
}

/**
 * When the hand must hurry, a painter shortens the moves between strokes far more
 * than the strokes themselves; the lag controller absorbs the throughput difference.
 */
function phaseSpeed(h: Hand): number {
  const s = h.speed
  if (s <= 1) return s
  return h.phase === 'stroke' ? s ** 0.6 : s ** 1.4
}

function advanceHand(engine: StrokeEngine, target: number, dtSec: number): void {
  const h = engine.hand
  const b = engine.brush
  h.clock += dtSec

  // How fast is the timer asking for strokes? (smoothed; timer ticks are coarse)
  const inst = dtSec > 0 ? Math.max(0, target - h.lastTarget) / dtSec : 0
  h.lastTarget = target
  h.rate += (inst - h.rate) * (1 - Math.exp(-dtSec / 1.2))

  const lag = target - h.next
  if (lag > 30) skipAhead(engine, Math.floor(target) - 2)

  // Match the hand's pace to the timer; drift gently so it trails ~1 stroke behind
  const needed = h.rate * h.avgCycle
  h.speed = clamp(Math.max(needed * (0.6 + 0.35 * Math.max(0, lag)), 0.25 * lag), 0.55, 500)

  let remaining = dtSec
  let guard = 0
  while (remaining > 1e-6 && guard++ < 2000) {
    if (h.phase === 'idle') {
      if (h.next < engine.strokes.length && h.next < target) {
        beginNext(engine, target)
        if (h.phase === 'idle') break
      } else {
        break
      }
    }
    const ps = phaseSpeed(h)
    const realNeeded = (h.dur - h.t) / ps
    if (remaining >= realNeeded) {
      h.t = h.dur
      remaining -= realNeeded
    } else {
      h.t += remaining * ps
      remaining = 0
    }
    updatePhase(engine)
    if (h.t >= h.dur - 1e-9) finishPhase(engine, target)
  }

  if (h.phase === 'idle') {
    if (h.next >= engine.strokes.length) {
      // Finished: hand drifts away off the canvas
      const k = 1 - Math.exp(-dtSec * 1.5)
      b.x = lerp(b.x, engine.width * 1.05, k)
      b.y = lerp(b.y, engine.height * 1.2, k)
      b.lift = lerp(b.lift, 1, k)
      h.targetAngle = REST_ANGLE
    } else {
      // Hovering, waiting for the timer: a little breathing drift
      b.lift = lerp(b.lift, 0.5, 1 - Math.exp(-dtSec * 3))
      b.x += Math.sin(h.clock * 1.7) * 0.15
      b.y += Math.cos(h.clock * 1.3) * 0.12
    }
  }

  // Wrist turns smoothly instead of snapping to each segment
  const tremor = b.lift < 0.05 ? Math.sin(h.clock * 9.3) * 0.025 + Math.sin(h.clock * 5.1) * 0.02 : 0
  const turn = 1 - Math.exp(-dtSec * 10 * Math.min(4, Math.max(1, h.speed)))
  b.angle += angleDiff(b.angle, h.targetAngle + tremor) * turn
}

/**
 * The screen shows only paint: no photo is ever faded in. The wet stroke is drawn
 * through the same path it will be committed with, so nothing pops when it lands.
 */
function compositeToScreen(ctx: CanvasRenderingContext2D, engine: StrokeEngine): void {
  ctx.save()
  ctx.globalAlpha = 1
  // The paint layer is opaque (it starts as gesso), so it replaces the whole frame
  ctx.drawImage(engine.paintLayer, 0, 0)
  // The wet stroke skips its ridge (drawn once when laid down) to keep frames light
  if (engine.activeStroke) renderStroke(ctx, engine, engine.activeStroke, false)
  ctx.restore()
}

/**
 * Classic flat paintbrush.
 * Tip (wide chisel edge) sits at the pose point; the handle extends along `angle`.
 * When lifted, the brush rises toward the viewer and its shadow separates from it.
 */
/** Graphite pencil for the sketch: sharpened cone, painted hexagonal body, eraser. */
function drawPencil(ctx: CanvasRenderingContext2D, brush: BrushPose): void {
  const lift = clamp(brush.lift, 0, 1)
  const bodyW = 15
  const coneH = 26
  const bodyH = 190
  const ferruleH = 16
  const eraserH = 14

  // Shadow: a thin sliver touching the tip, separating as the pencil lifts
  ctx.save()
  ctx.translate(brush.x + lift * 14, brush.y + lift * 20)
  ctx.rotate(brush.angle - Math.PI / 2)
  ctx.globalAlpha = 0.2 * (1 - lift * 0.5)
  ctx.fillStyle = 'rgb(30, 18, 10)'
  ctx.filter = lift > 0.05 ? `blur(${(2 + lift * 5).toFixed(1)}px)` : 'blur(1px)'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(bodyW * 0.5, coneH)
  ctx.lineTo(bodyW * 0.45, coneH + bodyH + ferruleH + eraserH)
  ctx.lineTo(-bodyW * 0.45, coneH + bodyH + ferruleH + eraserH)
  ctx.lineTo(-bodyW * 0.5, coneH)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.translate(brush.x - lift * 3, brush.y - lift * 5)
  ctx.scale(1 + lift * 0.06, 1 + lift * 0.06)
  ctx.rotate(brush.angle - Math.PI / 2)

  // Sharpened wood cone with the graphite point
  const wood = ctx.createLinearGradient(-bodyW / 2, 0, bodyW / 2, 0)
  wood.addColorStop(0, '#b98a5a')
  wood.addColorStop(0.45, '#ecc999')
  wood.addColorStop(1, '#a8794b')
  ctx.fillStyle = wood
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(bodyW / 2, coneH)
  // Scalloped edge where the sharpener cut the paint
  for (let i = 0; i <= 6; i++) {
    const x = bodyW / 2 - (i * bodyW) / 6
    ctx.lineTo(x, coneH + (i % 2 ? -2 : 0))
  }
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#3b3632'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(bodyW * 0.17, coneH * 0.34)
  ctx.lineTo(-bodyW * 0.17, coneH * 0.34)
  ctx.closePath()
  ctx.fill()

  // Painted hexagonal body: three facets
  const facets = ['#2f5d3a', '#3f7a4d', '#244a2e']
  for (let f = 0; f < 3; f++) {
    ctx.fillStyle = facets[f]!
    ctx.fillRect(-bodyW / 2 + (f * bodyW) / 3, coneH, bodyW / 3 + 0.5, bodyH)
  }
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  ctx.fillRect(-bodyW / 2 + bodyW / 3 + 1, coneH + 4, 2, bodyH - 8)

  // Ferrule and eraser
  const metal = ctx.createLinearGradient(-bodyW / 2, 0, bodyW / 2, 0)
  metal.addColorStop(0, '#7d848c')
  metal.addColorStop(0.45, '#e8ecf0')
  metal.addColorStop(1, '#6b727a')
  ctx.fillStyle = metal
  ctx.fillRect(-bodyW / 2, coneH + bodyH, bodyW, ferruleH)
  ctx.fillStyle = '#d98a8a'
  ctx.beginPath()
  ctx.roundRect(-bodyW / 2, coneH + bodyH + ferruleH, bodyW, eraserH, [0, 0, 4, 4])
  ctx.fill()
  ctx.restore()
}

export function drawBrush(ctx: CanvasRenderingContext2D, brush: BrushPose): void {
  if (!brush.visible) return
  if (brush.tool === 'pencil') {
    drawPencil(ctx, brush)
    return
  }

  // Big flats for blocking in, small rounds for detail
  const s = clamp(brush.tipWidth * 1.3, 15, 44)
  const lift = clamp(brush.lift, 0, 1)
  // Tip is WIDE; ferrule end is narrower (real flat-brush silhouette)
  const tipW = s * 1.35
  const rootW = s * 0.78
  const bristleH = s * 1.35
  const ferruleH = s * 0.95
  const ferruleW = rootW * 1.05
  const handleH = s * 5.6
  const handleTopW = ferruleW * 0.92
  const handleEndW = s * 0.32

  // Shadow on the canvas: tight under the tip when touching, offset and soft when raised
  ctx.save()
  ctx.translate(brush.x + lift * s * 0.55, brush.y + lift * s * 0.8)
  ctx.rotate(brush.angle - Math.PI / 2)
  ctx.globalAlpha = 0.22 * (1 - lift * 0.55)
  ctx.fillStyle = 'rgb(30, 18, 10)'
  ctx.filter = lift > 0.05 ? `blur(${(2 + lift * 6).toFixed(1)}px)` : 'none'
  ctx.beginPath()
  ctx.ellipse(0, s * 0.1, tipW * 0.5, s * 0.16, 0, 0, Math.PI * 2)
  ctx.fill()
  if (lift > 0.05) {
    ctx.beginPath()
    ctx.moveTo(-rootW * 0.45, bristleH)
    ctx.lineTo(rootW * 0.45, bristleH)
    ctx.lineTo(handleEndW * 0.5, bristleH + ferruleH + handleH * 0.9)
    ctx.lineTo(-handleEndW * 0.5, bristleH + ferruleH + handleH * 0.9)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  ctx.save()
  ctx.translate(brush.x - lift * s * 0.12, brush.y - lift * s * 0.2)
  ctx.scale(1 + lift * 0.07, 1 + lift * 0.07)
  ctx.rotate(brush.angle - Math.PI / 2)

  // --- Bristle block: wide at tip (y≈0), gathered at ferrule (y=bristleH) ---
  const hairGrad = ctx.createLinearGradient(0, 0, 0, bristleH)
  hairGrad.addColorStop(0, '#d9b87a')
  hairGrad.addColorStop(0.55, '#c49a5c')
  hairGrad.addColorStop(1, '#9a7340')
  ctx.fillStyle = hairGrad
  ctx.beginPath()
  ctx.moveTo(-tipW / 2, s * 0.08)
  ctx.lineTo(tipW / 2, s * 0.08)
  ctx.lineTo(rootW / 2, bristleH)
  ctx.lineTo(-rootW / 2, bristleH)
  ctx.closePath()
  ctx.fill()

  // Hair strands fanning toward the tip
  ctx.lineWidth = Math.max(1, s * 0.045)
  for (let i = -6; i <= 6; i++) {
    const t = i / 6
    const xTip = t * tipW * 0.46
    const xRoot = t * rootW * 0.4
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(70, 45, 20, 0.4)' : 'rgba(255, 230, 180, 0.25)'
    ctx.beginPath()
    ctx.moveTo(xRoot, bristleH * 0.95)
    ctx.quadraticCurveTo(xTip * 0.9, bristleH * 0.45, xTip, s * 0.1)
    ctx.stroke()
  }

  // Wet paint load along the flat tip edge
  ctx.fillStyle = brush.color
  ctx.beginPath()
  ctx.moveTo(-tipW * 0.52, s * 0.02)
  ctx.lineTo(tipW * 0.52, s * 0.02)
  ctx.lineTo(tipW * 0.48, s * 0.32)
  ctx.quadraticCurveTo(0, s * 0.4, -tipW * 0.48, s * 0.32)
  ctx.closePath()
  ctx.fill()
  // Gloss on wet paint
  ctx.fillStyle = 'rgba(255,255,255,0.28)'
  ctx.beginPath()
  ctx.ellipse(-tipW * 0.12, s * 0.14, tipW * 0.18, s * 0.06, -0.2, 0, Math.PI * 2)
  ctx.fill()

  // --- Metal ferrule ---
  const fy = bristleH
  const metal = ctx.createLinearGradient(-ferruleW / 2, 0, ferruleW / 2, 0)
  metal.addColorStop(0, '#5c636c')
  metal.addColorStop(0.2, '#aeb6c0')
  metal.addColorStop(0.45, '#eef2f6')
  metal.addColorStop(0.7, '#9aa3ae')
  metal.addColorStop(1, '#4e555e')
  ctx.fillStyle = metal
  ctx.beginPath()
  ctx.roundRect(-ferruleW / 2, fy - s * 0.04, ferruleW, ferruleH + s * 0.04, s * 0.08)
  ctx.fill()
  ctx.strokeStyle = 'rgba(30, 35, 40, 0.45)'
  ctx.lineWidth = Math.max(1, s * 0.04)
  for (const t of [0.25, 0.5, 0.75]) {
    const y = fy + ferruleH * t
    ctx.beginPath()
    ctx.moveTo(-ferruleW * 0.4, y)
    ctx.lineTo(ferruleW * 0.4, y)
    ctx.stroke()
  }

  // --- Long wooden handle ---
  const hy = fy + ferruleH
  const wood = ctx.createLinearGradient(-handleTopW / 2, 0, handleTopW / 2, 0)
  wood.addColorStop(0, '#2e1a0e')
  wood.addColorStop(0.3, '#7a4a28')
  wood.addColorStop(0.5, '#c48a4e')
  wood.addColorStop(0.75, '#8a5530')
  wood.addColorStop(1, '#3a2010')
  ctx.fillStyle = wood
  ctx.beginPath()
  ctx.moveTo(-handleTopW / 2, hy)
  ctx.lineTo(handleTopW / 2, hy)
  ctx.lineTo(handleEndW / 2, hy + handleH * 0.9)
  ctx.quadraticCurveTo(0, hy + handleH * 1.05, -handleEndW / 2, hy + handleH * 0.9)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = 'rgba(255, 215, 160, 0.4)'
  ctx.lineWidth = Math.max(1.8, s * 0.08)
  ctx.beginPath()
  ctx.moveTo(-handleTopW * 0.15, hy + s * 0.2)
  ctx.lineTo(-handleEndW * 0.1, hy + handleH * 0.78)
  ctx.stroke()

  ctx.restore()
}

/**
 * Advance the painter's hand toward timer progress.
 * Call every animation frame with dt (ms) for smooth motion.
 */
export function tickPainting(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  progress: number,
  dtMs: number,
): void {
  const clamped = Math.max(0, Math.min(1, progress))
  // Every stroke is down by paintEnd; after that the finished piece stays on show
  const paintT = Math.min(1, clamped / (engine.paintEnd ?? 0.94))
  const target = targetIndex(engine.phases, engine.strokes.length, paintT)

  advanceHand(engine, target, Math.max(0, dtMs) / 1000)

  // Once done, the hand sets the brush down and moves out of the picture
  const offCanvas = engine.brush.y > engine.height * 1.08
  if ((isPaintingComplete(engine) && offCanvas) || !engine.hand.started) {
    engine.brush.visible = false
  }

  compositeToScreen(ctx, engine)
  drawBrush(ctx, engine.brush)
}

/** Every stroke is on the canvas. */
export function isPaintingComplete(engine: StrokeEngine): boolean {
  return engine.hand.next >= engine.strokes.length && !engine.activeStroke
}

/**
 * How long the finished painting stays on show before the break ends. Kept within
 * 30–60 s; very short breaks (test mode) cap it so there's still time to paint.
 */
export const PREVIEW_SECONDS = 45

/** Fraction of the remaining break by which painting must be finished. */
export function paintEndFor(remainingSeconds: number): number {
  if (remainingSeconds <= 0) return 0.94
  const show = Math.min(PREVIEW_SECONDS, remainingSeconds * 0.3)
  return clamp(1 - show / remainingSeconds, 0.5, 0.97)
}

/** Instant jump used on setup / pause-seek. */
export function paintToProgress(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  progress: number,
): void {
  const clamped = Math.max(0, Math.min(1, progress))
  const target = targetIndex(engine.phases, engine.strokes.length, Math.min(1, clamped / (engine.paintEnd ?? 0.94)))
  skipAhead(engine, Math.floor(target))
  engine.hand.lastTarget = target
  tickPainting(ctx, engine, progress, 16)
}

export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = GESSO
  ctx.fillRect(0, 0, width, height)
  return ctx
}
