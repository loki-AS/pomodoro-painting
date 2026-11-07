export type Stroke = {
  points: { x: number; y: number }[]
  baseWidth: number
  alpha: number
  color: string
  kind: PassKind
  style: StrokeStyle
}

type PassKind = 'under' | 'block' | 'model' | 'detail'
type StrokeStyle = 'wash' | 'bristle' | 'dab' | 'edge'

export type BrushPose = {
  x: number
  y: number
  angle: number
  color: string
  tipWidth: number
  visible: boolean
}

export type StrokeEngine = {
  strokes: Stroke[]
  /** Continuous paint head: integer part = completed strokes, fraction = path along current */
  head: number
  source: HTMLCanvasElement
  paintLayer: HTMLCanvasElement
  paintCtx: CanvasRenderingContext2D
  width: number
  height: number
  brush: BrushPose
  /** Last point index committed on the active stroke */
  pathCursor: number
}

export const GESSO = '#e8dfd0'

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
}

type SampleBuf = {
  pixels: Uint8ClampedArray
  w: number
  h: number
}

function sampleColor(
  sample: SampleBuf,
  x: number,
  y: number,
  fullW: number,
  fullH: number,
  jitter = 10,
): string {
  const sx = clamp(Math.floor((x / fullW) * sample.w), 0, sample.w - 1)
  const sy = clamp(Math.floor((y / fullH) * sample.h), 0, sample.h - 1)
  const i = (sy * sample.w + sx) * 4
  let r = sample.pixels[i]!
  let g = sample.pixels[i + 1]!
  let b = sample.pixels[i + 2]!
  r = clamp(r + rand(-jitter, jitter), 0, 255)
  g = clamp(g + rand(-jitter, jitter), 0, 255)
  b = clamp(b + rand(-jitter, jitter), 0, 255)
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`
}

function regionAverageColor(
  sample: SampleBuf,
  cx: number,
  cy: number,
  radius: number,
  fullW: number,
  fullH: number,
  posterize = 20,
): string {
  const scaleX = sample.w / fullW
  const scaleY = sample.h / fullH
  const sx = cx * scaleX
  const sy = cy * scaleY
  const rx = radius * scaleX
  const ry = radius * scaleY
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  const x0 = clamp(Math.floor(sx - rx), 0, sample.w - 1)
  const x1 = clamp(Math.floor(sx + rx), 0, sample.w - 1)
  const y0 = clamp(Math.floor(sy - ry), 0, sample.h - 1)
  const y1 = clamp(Math.floor(sy + ry), 0, sample.h - 1)
  const step = Math.max(1, Math.floor(Math.max(rx, ry) / 5))

  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * sample.w + x) * 4
      r += sample.pixels[i]!
      g += sample.pixels[i + 1]!
      b += sample.pixels[i + 2]!
      n++
    }
  }

  if (!n) return sampleColor(sample, cx, cy, fullW, fullH, 8)
  const qr = ((r / n / posterize) | 0) * posterize
  const qg = ((g / n / posterize) | 0) * posterize
  const qb = ((b / n / posterize) | 0) * posterize
  return `rgb(${qr}, ${qg}, ${qb})`
}

function pickStyle(kind: PassKind): StrokeStyle {
  const roll = Math.random()
  if (kind === 'under') return roll < 0.55 ? 'wash' : 'bristle'
  if (kind === 'block') return roll < 0.6 ? 'bristle' : roll < 0.85 ? 'dab' : 'wash'
  if (kind === 'model') return roll < 0.7 ? 'bristle' : roll < 0.9 ? 'dab' : 'edge'
  return roll < 0.55 ? 'edge' : 'bristle'
}

function generateStroke(
  width: number,
  height: number,
  cx: number,
  cy: number,
  angle: number,
  kind: PassKind,
  sample: SampleBuf,
): Stroke {
  const specs = {
    under: { len: [90, 220], curve: 0.15, width: [70, 180], alpha: [0.72, 0.95], avgR: 100 },
    block: { len: [45, 140], curve: 0.28, width: [18, 50], alpha: [0.82, 0.98], avgR: 32 },
    model: { len: [28, 95], curve: 0.32, width: [7, 20], alpha: [0.85, 1], avgR: 14 },
    detail: { len: [10, 42], curve: 0.22, width: [2, 8], alpha: [0.88, 1], avgR: 4 },
  }[kind]

  const style = pickStyle(kind)
  const length =
    style === 'wash' ? rand(specs.len[0] * 0.4, specs.len[1] * 0.6) : rand(specs.len[0], specs.len[1])
  const curve = rand(-specs.curve, specs.curve)
  const steps = Math.max(5, Math.floor(length / (style === 'wash' ? 14 : 7)))
  const points: { x: number; y: number }[] = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const dist = t * length
    const bend = Math.sin(t * Math.PI) * curve * length
    const x = cx + Math.cos(angle) * dist + Math.cos(angle + Math.PI / 2) * bend
    const y = cy + Math.sin(angle) * dist + Math.sin(angle + Math.PI / 2) * bend
    points.push({ x: clamp(x, 0, width), y: clamp(y, 0, height) })
  }

  const mid = points[Math.floor(points.length / 2)] ?? { x: cx, y: cy }
  const color =
    kind === 'under' || kind === 'block'
      ? regionAverageColor(sample, mid.x, mid.y, specs.avgR, width, height, kind === 'under' ? 28 : 16)
      : sampleColor(sample, mid.x, mid.y, width, height, kind === 'detail' ? 4 : 12)

  return {
    points,
    baseWidth: rand(specs.width[0], specs.width[1]),
    alpha: rand(specs.alpha[0], specs.alpha[1]),
    color,
    kind,
    style,
  }
}

function orderedCellIndices(cols: number, rows: number): number[] {
  const cells: { i: number; dist: number }[] = []
  const cx = (cols - 1) / 2
  const cy = (rows - 1) / 2
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dist = Math.hypot(c - cx, r - cy) + rand(-0.35, 0.35)
      cells.push({ i: r * cols + c, dist })
    }
  }
  cells.sort((a, b) => a.dist - b.dist)
  return cells.map((c) => c.i)
}

function addPass(
  strokes: Stroke[],
  kind: PassKind,
  count: number,
  width: number,
  height: number,
  sample: SampleBuf,
): void {
  const aspect = width / height
  const cols = Math.max(2, Math.ceil(Math.sqrt(count * aspect)))
  const rows = Math.max(2, Math.ceil(count / cols))
  const cellW = width / cols
  const cellH = height / rows
  const regionAngles = new Map<string, number>()
  const perCell: Stroke[][] = Array.from({ length: cols * rows }, () => [])

  let made = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (made >= count) break
      const regionKey = `${Math.floor(r / 2)}_${Math.floor(c / 2)}`
      if (!regionAngles.has(regionKey)) {
        regionAngles.set(regionKey, rand(0, Math.PI))
      }
      const baseAngle = regionAngles.get(regionKey)!
      const angle = baseAngle + rand(-0.45, 0.45)
      const cx = (c + 0.5) * cellW + rand(-cellW * 0.35, cellW * 0.35)
      const cy = (r + 0.5) * cellH + rand(-cellH * 0.35, cellH * 0.35)
      const cellIndex = r * cols + c
      const extras = kind === 'under' ? 1 : kind === 'block' ? 1 + (Math.random() < 0.4 ? 1 : 0) : 1
      for (let e = 0; e < extras && made < count; e++) {
        perCell[cellIndex]!.push(
          generateStroke(
            width,
            height,
            cx + rand(-cellW * 0.15, cellW * 0.15),
            cy + rand(-cellH * 0.15, cellH * 0.15),
            angle + rand(-0.2, 0.2),
            kind,
            sample,
          ),
        )
        made++
      }
    }
  }

  for (const cell of perCell) shuffleInPlace(cell)
  for (const idx of orderedCellIndices(cols, rows)) {
    strokes.push(...(perCell[idx] ?? []))
  }
}

export function createStrokeEngine(
  image: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number,
  strokeCount = 1200,
): StrokeEngine {
  const source = document.createElement('canvas')
  source.width = canvasWidth
  source.height = canvasHeight
  const sctx = source.getContext('2d')
  if (!sctx) throw new Error('Could not create source canvas')

  const scale = Math.max(
    canvasWidth / image.naturalWidth,
    canvasHeight / image.naturalHeight,
  )
  const dw = image.naturalWidth * scale
  const dh = image.naturalHeight * scale
  const dx = (canvasWidth - dw) / 2
  const dy = (canvasHeight - dh) / 2
  sctx.fillStyle = GESSO
  sctx.fillRect(0, 0, canvasWidth, canvasHeight)
  sctx.drawImage(image, dx, dy, dw, dh)

  const sampleMax = 480
  const sampleScale = Math.min(1, sampleMax / Math.max(canvasWidth, canvasHeight))
  const sampleW = Math.max(1, Math.round(canvasWidth * sampleScale))
  const sampleH = Math.max(1, Math.round(canvasHeight * sampleScale))
  const sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = sampleW
  sampleCanvas.height = sampleH
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!sampleCtx) throw new Error('Could not create sample canvas')
  sampleCtx.drawImage(source, 0, 0, sampleW, sampleH)
  const sample: SampleBuf = {
    pixels: sampleCtx.getImageData(0, 0, sampleW, sampleH).data,
    w: sampleW,
    h: sampleH,
  }

  const paintLayer = document.createElement('canvas')
  paintLayer.width = canvasWidth
  paintLayer.height = canvasHeight
  const paintCtx = paintLayer.getContext('2d')
  if (!paintCtx) throw new Error('Could not create paint layer')
  paintCtx.fillStyle = GESSO
  paintCtx.fillRect(0, 0, canvasWidth, canvasHeight)

  const strokes: Stroke[] = []
  const under = Math.round(strokeCount * 0.18)
  const block = Math.round(strokeCount * 0.32)
  const model = Math.round(strokeCount * 0.34)
  const detail = Math.max(1, strokeCount - under - block - model)

  addPass(strokes, 'under', under, canvasWidth, canvasHeight, sample)
  addPass(strokes, 'block', block, canvasWidth, canvasHeight, sample)
  addPass(strokes, 'model', model, canvasWidth, canvasHeight, sample)
  addPass(strokes, 'detail', detail, canvasWidth, canvasHeight, sample)

  return {
    strokes,
    head: 0,
    source,
    paintLayer,
    paintCtx,
    width: canvasWidth,
    height: canvasHeight,
    pathCursor: 0,
    brush: {
      x: canvasWidth * 0.5,
      y: canvasHeight * 0.5,
      angle: -Math.PI / 4,
      color: '#5a4638',
      tipWidth: 18,
      visible: false,
    },
  }
}

function pressureWidth(baseWidth: number, t: number): number {
  const envelope = Math.sin(t * Math.PI)
  return Math.max(1.2, baseWidth * (0.35 + 0.65 * envelope))
}

function strokeAngleAt(stroke: Stroke, index: number): number {
  const pts = stroke.points
  if (pts.length < 2) return -Math.PI / 4
  const i0 = clamp(index, 0, pts.length - 2)
  const a = pts[i0]!
  const b = pts[i0 + 1]!
  return Math.atan2(b.y - a.y, b.x - a.x)
}

function setBrush(
  engine: StrokeEngine,
  stroke: Stroke,
  pointIndex: number,
  visible: boolean,
): void {
  const pts = stroke.points
  const p = pts[clamp(pointIndex, 0, pts.length - 1)]!
  engine.brush.x = p.x
  engine.brush.y = p.y
  engine.brush.angle = strokeAngleAt(stroke, pointIndex)
  engine.brush.color = stroke.color
  engine.brush.tipWidth = Math.max(6, Math.min(42, stroke.baseWidth * 0.55))
  engine.brush.visible = visible
}

/** Paint one path segment (bristle / edge / dab) between two points. */
function paintSegment(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  i0: number,
  i1: number,
): void {
  const pts = stroke.points
  if (i0 < 0 || i1 >= pts.length || i1 <= i0) return
  const p0 = pts[i0]!
  const p1 = pts[i1]!
  const t = i1 / Math.max(1, pts.length - 1)
  const w = pressureWidth(stroke.baseWidth, t)

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color

  if (stroke.style === 'dab' || stroke.style === 'wash') {
    ctx.globalAlpha = stroke.alpha * rand(0.8, 1)
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x)
    ctx.translate(p1.x, p1.y)
    ctx.rotate(ang)
    ctx.beginPath()
    ctx.ellipse(0, 0, w * 0.45, w * 0.22, 0, 0, Math.PI * 2)
    ctx.fill()
  } else if (stroke.style === 'edge') {
    ctx.globalAlpha = stroke.alpha
    ctx.lineWidth = w * 0.85
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    ctx.lineTo(p1.x, p1.y)
    ctx.stroke()
  } else {
    // bristle: a few parallel hairs for this segment
    const hairs = Math.max(3, Math.min(6, Math.round(stroke.baseWidth / 8)))
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) + Math.PI / 2
    for (let h = 0; h < hairs; h++) {
      const offset = (h - (hairs - 1) / 2) * (w / hairs)
      const ox = Math.cos(ang) * offset
      const oy = Math.sin(ang) * offset
      ctx.globalAlpha = stroke.alpha * rand(0.7, 1)
      ctx.lineWidth = Math.max(1.2, w / hairs)
      ctx.beginPath()
      ctx.moveTo(p0.x + ox, p0.y + oy)
      ctx.lineTo(p1.x + ox, p1.y + oy)
      ctx.stroke()
    }
  }
  ctx.restore()
}

function paintStrokeIndex(progress: number, total: number): number {
  const t = Math.max(0, Math.min(1, progress))
  let phase: number
  if (t < 0.25) phase = (t / 0.25) * 0.18
  else if (t < 0.55) phase = 0.18 + ((t - 0.25) / 0.3) * 0.32
  else if (t < 0.85) phase = 0.5 + ((t - 0.55) / 0.3) * 0.34
  else phase = 0.84 + ((t - 0.85) / 0.15) * 0.16
  return Math.min(total, phase * total)
}

function compositeToScreen(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  settleAlpha: number,
): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = GESSO
  ctx.fillRect(0, 0, engine.width, engine.height)
  ctx.drawImage(engine.paintLayer, 0, 0)
  if (settleAlpha > 0) {
    ctx.globalAlpha = settleAlpha
    ctx.drawImage(engine.source, 0, 0)
  }
  ctx.restore()
}

/**
 * Classic flat paintbrush.
 * Tip (wide chisel edge) sits on the canvas at (0,0); bristles gather into the ferrule; handle trails.
 */
export function drawBrush(ctx: CanvasRenderingContext2D, brush: BrushPose): void {
  if (!brush.visible) return

  const s = Math.max(26, Math.min(44, brush.tipWidth * 1.25))
  // Tip is WIDE; ferrule end is narrower (real flat-brush silhouette)
  const tipW = s * 1.35
  const rootW = s * 0.78
  const bristleH = s * 1.35
  const ferruleH = s * 0.95
  const ferruleW = rootW * 1.05
  const handleH = s * 5.6
  const handleTopW = ferruleW * 0.92
  const handleEndW = s * 0.32

  ctx.save()
  ctx.translate(brush.x, brush.y)
  ctx.rotate(brush.angle + Math.PI)
  ctx.rotate(0.4)

  // Soft shadow under tip
  ctx.fillStyle = 'rgba(30, 18, 10, 0.22)'
  ctx.beginPath()
  ctx.ellipse(0, s * 0.06, tipW * 0.48, s * 0.14, 0, 0, Math.PI * 2)
  ctx.fill()

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
 * Advance the brush toward timer progress.
 * Call every animation frame with dt (ms) for smooth motion.
 */
export function tickPainting(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  progress: number,
  dtMs: number,
): void {
  const clamped = Math.max(0, Math.min(1, progress))
  const paintT = Math.min(1, clamped / 0.94)
  const targetHead = paintStrokeIndex(paintT, engine.strokes.length)
  const settleAlpha = clamped >= 0.94 ? (clamped - 0.94) / 0.06 : 0

  // Catch up speed: strokes per second (faster if behind)
  const behind = targetHead - engine.head
  const baseSpeed = 14 // strokes/sec when slightly behind
  const catchUp = Math.min(90, baseSpeed + Math.max(0, behind) * 8)
  const step = (catchUp * dtMs) / 1000
  const nextHead = Math.min(targetHead, engine.head + Math.max(step, behind > 0 ? 0.002 : 0))

  // Commit paint from engine.head → nextHead along stroke paths
  let head = engine.head
  while (head < nextHead && head < engine.strokes.length) {
    const strokeIndex = Math.floor(head)
    const stroke = engine.strokes[strokeIndex]
    if (!stroke) break

    const localEnd = Math.min(1, nextHead - strokeIndex)
    const pts = stroke.points
    const endIdx = Math.max(0, Math.floor(localEnd * (pts.length - 1)))

    // First contact: drop a loaded tip blotch
    if (engine.pathCursor === 0 && endIdx >= 0) {
      const p = pts[0]!
      engine.paintCtx.save()
      engine.paintCtx.fillStyle = stroke.color
      engine.paintCtx.globalAlpha = stroke.alpha
      engine.paintCtx.beginPath()
      engine.paintCtx.ellipse(
        p.x,
        p.y,
        stroke.baseWidth * (stroke.style === 'wash' ? 0.5 : 0.28),
        stroke.baseWidth * (stroke.style === 'wash' ? 0.34 : 0.16),
        strokeAngleAt(stroke, 0),
        0,
        Math.PI * 2,
      )
      engine.paintCtx.fill()
      engine.paintCtx.restore()
    }

    for (let i = engine.pathCursor + 1; i <= endIdx; i++) {
      paintSegment(engine.paintCtx, stroke, i - 1, i)
    }

    setBrush(engine, stroke, endIdx, settleAlpha < 0.85)

    if (localEnd >= 1) {
      engine.pathCursor = 0
      head = strokeIndex + 1
    } else {
      engine.pathCursor = endIdx
      head = strokeIndex + localEnd
      break
    }
  }

  engine.head = Math.min(nextHead, engine.strokes.length)

  if (settleAlpha >= 0.85) {
    engine.brush.visible = false
  }

  compositeToScreen(ctx, engine, settleAlpha)
  drawBrush(ctx, engine.brush)
}

/** Instant jump used on setup / pause-seek. */
export function paintToProgress(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  progress: number,
): void {
  tickPainting(ctx, engine, progress, 60_000)
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
