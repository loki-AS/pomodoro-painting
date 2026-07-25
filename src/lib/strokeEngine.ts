export type Stroke = {
  points: { x: number; y: number }[]
  width: number
  alpha: number
}

export type StrokeEngine = {
  strokes: Stroke[]
  drawnCount: number
  source: HTMLCanvasElement
  pattern: CanvasPattern | null
  width: number
  height: number
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function generateStroke(
  width: number,
  height: number,
  cx: number,
  cy: number,
): Stroke {
  const angle = rand(0, Math.PI * 2)
  const length = rand(28, 120)
  const curve = rand(-0.5, 0.5)
  const steps = Math.max(4, Math.floor(length / 8))
  const points: { x: number; y: number }[] = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const dist = t * length
    const bend = Math.sin(t * Math.PI) * curve * length
    const x = cx + Math.cos(angle) * dist + Math.cos(angle + Math.PI / 2) * bend
    const y = cy + Math.sin(angle) * dist + Math.sin(angle + Math.PI / 2) * bend
    points.push({
      x: Math.max(0, Math.min(width, x)),
      y: Math.max(0, Math.min(height, y)),
    })
  }

  return {
    points,
    width: rand(8, 32),
    alpha: rand(0.82, 1),
  }
}

export function createStrokeEngine(
  image: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number,
  strokeCount = 1400,
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
  sctx.fillStyle = '#1a1612'
  sctx.fillRect(0, 0, canvasWidth, canvasHeight)
  sctx.drawImage(image, dx, dy, dw, dh)

  const strokes: Stroke[] = []
  const cols = Math.ceil(Math.sqrt(strokeCount * (canvasWidth / canvasHeight)))
  const rows = Math.ceil(strokeCount / cols)
  const cellW = canvasWidth / cols
  const cellH = canvasHeight / rows

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (strokes.length >= strokeCount) break
      const cx = (c + 0.5) * cellW + rand(-cellW * 0.35, cellW * 0.35)
      const cy = (r + 0.5) * cellH + rand(-cellH * 0.35, cellH * 0.35)
      strokes.push(generateStroke(canvasWidth, canvasHeight, cx, cy))
    }
  }

  for (let i = strokes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = strokes[i]!
    strokes[i] = strokes[j]!
    strokes[j] = tmp
  }

  return {
    strokes,
    drawnCount: 0,
    source,
    pattern: null,
    width: canvasWidth,
    height: canvasHeight,
  }
}

function getPattern(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
): CanvasPattern {
  if (!engine.pattern) {
    const pattern = ctx.createPattern(engine.source, 'no-repeat')
    if (!pattern) throw new Error('Could not create paint pattern')
    engine.pattern = pattern
  }
  return engine.pattern
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  pattern: CanvasPattern,
  stroke: Stroke,
): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = stroke.alpha
  ctx.strokeStyle = pattern
  ctx.lineWidth = stroke.width
  ctx.beginPath()
  stroke.points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()
  ctx.restore()
}

export function paintToProgress(
  ctx: CanvasRenderingContext2D,
  engine: StrokeEngine,
  progress: number,
): void {
  const clamped = Math.max(0, Math.min(1, progress))
  const target = Math.min(
    engine.strokes.length,
    Math.floor(clamped * engine.strokes.length),
  )
  const pattern = getPattern(ctx, engine)

  while (engine.drawnCount < target) {
    drawStroke(ctx, pattern, engine.strokes[engine.drawnCount]!)
    engine.drawnCount++
  }

  if (clamped >= 1) {
    ctx.globalAlpha = 1
    ctx.drawImage(engine.source, 0, 0)
    engine.drawnCount = engine.strokes.length
  }
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
  ctx.fillStyle = '#2a241c'
  ctx.fillRect(0, 0, width, height)
  return ctx
}
