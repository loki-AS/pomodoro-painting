/**
 * Paint planning: decides what a painter would do to reproduce an image, in order.
 *
 *  1. Sketch     – pencil contours traced from the image's strongest edges.
 *  2. Tone       – a thin, warm monochrome wash establishing lights and darks.
 *  3. Block-in   – big brushes laying in colour masses (from a heavily blurred image).
 *  4. Form       – medium brushes modelling shapes.
 *  5. Refine     – small brushes sharpening transitions.
 *  6. Detail     – tiny brushes, only where detail still matters.
 *
 * Every paint layer has a reference: the image blurred to that layer's brush scale.
 * A stroke carries that reference's content inside its footprint (plus a touch of
 * its own paint colour), so later layers converge on the real picture. Strokes are
 * placed only where a simulated canvas still differs from the layer's reference,
 * worst places first (Hertzmann's painterly-rendering approach), and they follow the
 * image's contours.
 */

export type RGB = [number, number, number]
export type LayerKind = 'sketch' | 'tone' | 'block' | 'form' | 'refine' | 'detail'
export type StrokeStyle = 'pencil' | 'wash' | 'bristle' | 'dab' | 'edge'

export type Stroke = {
  points: { x: number; y: number }[]
  /** Cumulative arc length at each point (cum[0] = 0) */
  cum: number[]
  /** Unit normal at each point, averaged over neighbours so offset edges stay continuous */
  normals: { x: number; y: number }[]
  length: number
  /** Pixel bounds of the stroke including brush width */
  bbox: { x: number; y: number; w: number; h: number }
  baseWidth: number
  /** Applied once when the finished stroke is laid onto the canvas */
  alpha: number
  /** Per-hair paint colour, fixed for the whole stroke so bristle tracks stay continuous */
  hairRgb: RGB[]
  /** Fraction of the stroke each hair lasts before running dry */
  hairEnd: number[]
  /** Hair thickness relative to its share of the brush (<1 leaves fine streaks) */
  hairFill: number
  color: string
  rgb: RGB
  /** Wet paint the brush picked up from the canvas at touchdown (set while painting) */
  pickup: RGB | null
  /** How much picked-up paint mixes into the brush load at the start of the stroke */
  mix: number
  /** Dry-brush amount: how much paint skips over the canvas weave (0 = none) */
  dry: number
  kind: LayerKind
  style: StrokeStyle
  /** Index into the plan's reference images; -1 = flat colour (pencil) */
  level: number
  /** How much the brush's own colour shows over the reference (0 = pure reference) */
  tint: number
  /** Natural speed along the stroke, px/sec */
  speed: number
  /** Paint thickness (impasto ridge strength): loose early layers stand proud, fine work is flat */
  relief: number
}

export type Phase = { kind: LayerKind; start: number; end: number; t0: number; t1: number }

export type PaintPlan = {
  strokes: Stroke[]
  phases: Phase[]
  /** Reference image per paint layer (index = Stroke.level) */
  refs: HTMLCanvasElement[]
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1))
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function rgbString(c: RGB): string {
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')
  return [c, ctx]
}

export const GESSO_RGB: RGB = [0xe8, 0xdf, 0xd0]

// ---------------------------------------------------------------------------
// Hand timing (shared with the engine so phase timing matches the real hand)
// ---------------------------------------------------------------------------

function isFine(s: Stroke): boolean {
  return s.style === 'pencil' || s.baseWidth < 14
}

export function downSec(s: Stroke): number {
  return isFine(s) ? 0.05 : 0.08
}

export function liftSec(s: Stroke): number {
  return isFine(s) ? 0.06 : 0.1
}

/** Hatching between nearby small strokes barely leaves the canvas. */
export function travelSec(dist: number, next: Stroke): number {
  if (isFine(next) && dist < 60) return 0.04 + dist / 1500
  return clamp(0.12 + dist / 1100, 0.12, 0.75)
}

export function strokeSec(s: Stroke): number {
  return clamp(s.length / s.speed, s.style === 'pencil' ? 0.15 : 0.08, 1.2)
}

// ---------------------------------------------------------------------------
// Layer recipes (sizes are at an 800px canvas and scale with the screen)
// ---------------------------------------------------------------------------

type LayerSpec = {
  kind: Exclude<LayerKind, 'sketch'>
  /** Blur of this layer's reference image */
  sigma: number
  width: number
  len: [number, number]
  alpha: [number, number]
  /** Min mean RGB error in a cell before a stroke is placed there */
  threshold: number
  /** A stroke ends when the reference under it drifts this far from its colour */
  stopDist: number
  styles: [StrokeStyle, number][]
  tint: number
  mix: number
  speed: number
  /** Share of the stroke budget; cover layers instead paint until nothing is bare */
  share: number
  cover: boolean
  /** Dry-brush and ridge texture: strong in loose early layers, near zero in fine work */
  texture: number
}

const LAYERS: LayerSpec[] = [
  { kind: 'tone', sigma: 26, width: 110, len: [220, 440], alpha: [0.55, 0.7], threshold: 12, stopDist: Infinity, styles: [['wash', 1]], tint: 0.15, mix: 0, speed: 640, share: 0, cover: true, texture: 1 },
  { kind: 'block', sigma: 12, width: 46, len: [90, 260], alpha: [0.94, 0.99], threshold: 10, stopDist: 48, styles: [['bristle', 0.7], ['wash', 0.3]], tint: 0.12, mix: 0.25, speed: 480, share: 0, cover: true, texture: 0.5 },
  { kind: 'form', sigma: 4, width: 24, len: [40, 150], alpha: [0.9, 0.98], threshold: 13, stopDist: 38, styles: [['bristle', 0.75], ['dab', 0.25]], tint: 0.07, mix: 0.2, speed: 380, share: 0.3, cover: false, texture: 0.45 },
  { kind: 'refine', sigma: 1.5, width: 13, len: [18, 80], alpha: [0.93, 1], threshold: 16, stopDist: 30, styles: [['bristle', 0.55], ['edge', 0.45]], tint: 0.04, mix: 0.12, speed: 300, share: 0.33, cover: false, texture: 0.2 },
  { kind: 'detail', sigma: 0, width: 7, len: [8, 40], alpha: [0.95, 1], threshold: 18, stopDist: 26, styles: [['edge', 0.7], ['bristle', 0.3]], tint: 0.02, mix: 0.05, speed: 220, share: 0.37, cover: false, texture: 0.08 },
]

function pickStyle(styles: [StrokeStyle, number][]): StrokeStyle {
  let r = Math.random()
  for (const [s, p] of styles) {
    if ((r -= p) <= 0) return s
  }
  return styles[styles.length - 1]![0]
}

// ---------------------------------------------------------------------------
// Reference images
// ---------------------------------------------------------------------------

function supportsFilter(): boolean {
  const [, ctx] = makeCanvas(1, 1)
  ctx.filter = 'blur(2px)'
  return ctx.filter === 'blur(2px)'
}

/** The image blurred by `sigma`, with edges extended so borders don't fade out. */
function makeRef(source: HTMLCanvasElement, W: number, H: number, sigma: number, filterOk: boolean): HTMLCanvasElement {
  const [out, ctx] = makeCanvas(W, H)
  if (sigma <= 0.5) {
    ctx.drawImage(source, 0, 0)
    return out
  }
  const pad = Math.ceil(sigma * 3) + 2
  const [padded, pctx] = makeCanvas(W + pad * 2, H + pad * 2)
  pctx.drawImage(source, 0, 0, W + pad * 2, H + pad * 2)
  pctx.drawImage(source, pad, pad)

  if (filterOk) {
    ctx.filter = `blur(${sigma.toFixed(1)}px)`
    ctx.drawImage(padded, -pad, -pad)
    ctx.filter = 'none'
  } else {
    // Downscale/upscale blur for browsers without ctx.filter
    const k = Math.max(1, sigma / 1.2)
    const [small, sctx] = makeCanvas((W + pad * 2) / k, (H + pad * 2) / k)
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(padded, 0, 0, small.width, small.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(small, -pad, -pad, W + pad * 2, H + pad * 2)
  }
  return out
}

/** Warm, mostly monochrome version for the tonal underpainting (burnt-umber wash). */
function toneInPlace(c: HTMLCanvasElement): void {
  const ctx = c.getContext('2d')!
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    d[i] = lerp(l * 1.04 + 14, d[i]!, 0.22)
    d[i + 1] = lerp(l * 0.93 + 6, d[i + 1]!, 0.22)
    d[i + 2] = lerp(l * 0.76, d[i + 2]!, 0.22)
  }
  ctx.putImageData(img, 0, 0)
}

function toSample(c: HTMLCanvasElement, sw: number, sh: number): Uint8ClampedArray {
  const [, ctx] = makeCanvas(sw, sh)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(c, 0, 0, sw, sh)
  return ctx.getImageData(0, 0, sw, sh).data
}

// ---------------------------------------------------------------------------
// Direction field: strokes run along edges, not across them
// ---------------------------------------------------------------------------

type Field = {
  w: number
  h: number
  /** Smoothed structure tensor in doubled-angle form (Jxx - Jyy, 2Jxy) */
  jx: Float32Array
  jy: Float32Array
  /** Below this tensor strength, fall back to a slowly varying direction */
  eps: number
  /** Coarse grid of fallback angles for flat regions */
  fb: Float32Array
  fbCols: number
  fbRows: number
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const span = r * 2 + 1
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[y * w + clamp(k, 0, w - 1)]!
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / span
      acc += src[y * w + clamp(x + r + 1, 0, w - 1)]! - src[y * w + clamp(x - r, 0, w - 1)]!
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x]!
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x]! - tmp[clamp(y - r, 0, h - 1) * w + x]!
    }
  }
  return out
}

function luminance(px: Uint8ClampedArray, n: number): Float32Array {
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!
  }
  return lum
}

function sobel(lum: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h)
  const gy = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      gx[i] =
        lum[i - w + 1]! + 2 * lum[i + 1]! + lum[i + w + 1]! - lum[i - w - 1]! - 2 * lum[i - 1]! - lum[i + w - 1]!
      gy[i] =
        lum[i + w - 1]! + 2 * lum[i + w]! + lum[i + w + 1]! - lum[i - w - 1]! - 2 * lum[i - w]! - lum[i - w + 1]!
    }
  }
  return { gx, gy }
}

function buildField(sharp: Uint8ClampedArray, w: number, h: number): Field {
  const { gx, gy } = sobel(luminance(sharp, w * h), w, h)
  let jxx: Float32Array = new Float32Array(w * h)
  let jxy: Float32Array = new Float32Array(w * h)
  let jyy: Float32Array = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    jxx[i] = gx[i]! * gx[i]!
    jxy[i] = gx[i]! * gy[i]!
    jyy[i] = gy[i]! * gy[i]!
  }
  const r = Math.max(2, Math.round(Math.min(w, h) / 90))
  jxx = boxBlur(boxBlur(jxx, w, h, r), w, h, r)
  jxy = boxBlur(boxBlur(jxy, w, h, r), w, h, r)
  jyy = boxBlur(boxBlur(jyy, w, h, r), w, h, r)

  const jx = new Float32Array(w * h)
  const jy = new Float32Array(w * h)
  const strengths: number[] = []
  for (let i = 0; i < w * h; i++) {
    jx[i] = jxx[i]! - jyy[i]!
    jy[i] = 2 * jxy[i]!
    if (i % 7 === 0) strengths.push(Math.hypot(jx[i]!, jy[i]!))
  }
  strengths.sort((a, b) => a - b)
  const eps = (strengths[Math.floor(strengths.length * 0.35)] ?? 0) + 1e-3

  const fbCols = 6
  const fbRows = 4
  const fb = Float32Array.from({ length: fbCols * fbRows }, () => rand(0, Math.PI))
  return { w, h, jx, jy, eps, fb, fbCols, fbRows }
}

/** Direction along the local edge; blends into a slow fallback field where flat. */
function flowAngle(f: Field, sx: number, sy: number): number {
  const x = clamp(Math.floor(sx), 0, f.w - 1)
  const y = clamp(Math.floor(sy), 0, f.h - 1)
  const i = y * f.w + x
  const fbA = f.fb[clamp(Math.floor((y / f.h) * f.fbRows), 0, f.fbRows - 1) * f.fbCols +
    clamp(Math.floor((x / f.w) * f.fbCols), 0, f.fbCols - 1)]!
  // Tangent = gradient's doubled angle + PI, i.e. the negated tensor vector
  const vx = -f.jx[i]! + Math.cos(2 * fbA) * f.eps
  const vy = -f.jy[i]! + Math.sin(2 * fbA) * f.eps
  return Math.atan2(vy, vx) / 2
}

// ---------------------------------------------------------------------------
// Stroke construction
// ---------------------------------------------------------------------------

type PlanCtx = {
  W: number
  H: number
  /** Size scale relative to an 800px canvas */
  s: number
  sw: number
  sh: number
  /** Sample pixels per canvas pixel */
  ss: number
  field: Field
}

function shade(c: RGB, d: number): RGB {
  return [clamp(c[0] + d, 0, 255), clamp(c[1] + d, 0, 255), clamp(c[2] + d, 0, 255)]
}

function geometry(points: { x: number; y: number }[]): { cum: number[]; normals: { x: number; y: number }[] } {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const normals = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)]!
    const b = points[Math.min(points.length - 1, i + 1)]!
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2
    return { x: Math.cos(ang), y: Math.sin(ang) }
  })
  return { cum, normals }
}

function buildStroke(
  c: PlanCtx,
  points: { x: number; y: number }[],
  width: number,
  rgb: RGB,
  o: Pick<Stroke, 'alpha' | 'kind' | 'style' | 'level' | 'tint' | 'mix' | 'dry' | 'speed' | 'relief'>,
): Stroke {
  const { cum, normals } = geometry(points)
  const hairs = o.style === 'bristle' ? clamp(Math.round(width / 5), 3, 9) : 1
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  const pad = width * 0.6 + 4
  const bx = Math.max(0, Math.floor(x0 - pad))
  const by = Math.max(0, Math.floor(y0 - pad))
  return {
    points,
    cum,
    normals,
    length: Math.max(1, cum[cum.length - 1]!),
    bbox: {
      x: bx,
      y: by,
      w: Math.max(1, Math.min(c.W, Math.ceil(x1 + pad)) - bx),
      h: Math.max(1, Math.min(c.H, Math.ceil(y1 + pad)) - by),
    },
    baseWidth: width,
    hairRgb: Array.from({ length: hairs }, () => shade(rgb, rand(-10, 10))),
    hairEnd: Array.from({ length: hairs }, () => (Math.random() < 0.65 ? 1 : rand(0.86, 0.98))),
    hairFill: o.level >= 0 ? 0.985 : 1.04,
    color: rgbString(rgb),
    rgb,
    pickup: null,
    ...o,
  }
}

/** Reverse a stroke's direction in place (used when chaining strokes end to start). */
function reverseStroke(st: Stroke): void {
  st.points.reverse()
  const { cum, normals } = geometry(st.points)
  st.cum = cum
  st.normals = normals
}

function refRgb(ref: Uint8ClampedArray, c: PlanCtx, x: number, y: number): RGB {
  const sx = clamp(Math.floor(x * c.ss), 0, c.sw - 1)
  const sy = clamp(Math.floor(y * c.ss), 0, c.sh - 1)
  const i = (sy * c.sw + sx) * 4
  return [ref[i]!, ref[i + 1]!, ref[i + 2]!]
}

/** Grow half a stroke along the contour field until the colour underneath changes. */
function traceHalf(
  c: PlanCtx,
  ref: Uint8ClampedArray,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxLen: number,
  minLen: number,
  step: number,
  inertia: number,
  rgb: RGB,
  stopDist: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  let travelled = 0
  while (travelled < maxLen) {
    const a = flowAngle(c.field, x * c.ss, y * c.ss)
    let tx = Math.cos(a)
    let ty = Math.sin(a)
    if (tx * dx + ty * dy < 0) {
      tx = -tx
      ty = -ty
    }
    dx = dx * inertia + tx * (1 - inertia)
    dy = dy * inertia + ty * (1 - inertia)
    const n = Math.hypot(dx, dy) || 1
    dx /= n
    dy /= n
    const nx = x + dx * step
    const ny = y + dy * step
    if (nx < 0 || ny < 0 || nx > c.W || ny > c.H) break
    if (travelled > minLen && stopDist < Infinity) {
      const s = refRgb(ref, c, nx, ny)
      if (Math.hypot(s[0] - rgb[0], s[1] - rgb[1], s[2] - rgb[2]) > stopDist) break
    }
    x = nx
    y = ny
    travelled += step
    out.push({ x, y })
  }
  return out
}

function traceStroke(c: PlanCtx, L: LayerSpec, level: number, ref: Uint8ClampedArray, cx: number, cy: number): Stroke {
  const width = L.width * c.s * rand(0.8, 1.2)
  const style = pickStyle(L.styles)
  const length = (style === 'dab' ? rand(L.len[0] * 0.4, L.len[0]) : rand(L.len[0], L.len[1])) * c.s
  const rgb = refRgb(ref, c, cx, cy)
  const step = clamp(width * 0.2, 2, 9)
  const inertia = clamp(0.55 + width / 350, 0.55, 0.9)
  const a0 = flowAngle(c.field, cx * c.ss, cy * c.ss) + rand(-0.08, 0.08)
  const minHalf = Math.min(length / 2, L.len[0] * c.s * 0.3)
  const fwd = traceHalf(c, ref, cx, cy, Math.cos(a0), Math.sin(a0), length / 2, minHalf, step, inertia, rgb, L.stopDist)
  const back = traceHalf(c, ref, cx, cy, -Math.cos(a0), -Math.sin(a0), length / 2, minHalf, step, inertia, rgb, L.stopDist)
  let points = [...back.reverse(), { x: cx, y: cy }, ...fwd]
  if (points.length < 3) {
    // Boxed in by colour change: a short touch instead
    points = [-1, 0, 1].map((k) => ({
      x: clamp(cx + Math.cos(a0) * k * step, 0, c.W),
      y: clamp(cy + Math.sin(a0) * k * step, 0, c.H),
    }))
  }
  return buildStroke(c, points, width, rgb, {
    alpha: rand(L.alpha[0], L.alpha[1]),
    kind: L.kind,
    style,
    level,
    tint: L.tint,
    mix: L.mix,
    // Dry-brush texture belongs to the loose early layers; fine work is smooth
    dry: L.texture * (style === 'edge' ? 0 : style === 'wash' ? rand(0.3, 0.5) : style === 'dab' ? rand(0.08, 0.25) : rand(0.1, 0.4)),
    speed: L.speed * c.s,
    relief: L.texture,
  })
}

// ---------------------------------------------------------------------------
// Simulated canvas: where is the painting still wrong?
// ---------------------------------------------------------------------------

/** Rasterise a stroke's footprint into the simulated canvas, blending toward its reference. */
function stamp(c: PlanCtx, virtual: Float32Array, ref: Uint8ClampedArray, st: Stroke): void {
  // Conservative: tapered ends and dry-brush gaps cover less than the full width
  const a = st.alpha * (1 - st.dry * 0.8)
  const r = Math.max(0.6, st.baseWidth * 0.34 * c.ss)
  for (const p of st.points) {
    const cx = p.x * c.ss
    const cy = p.y * c.ss
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(c.sh - 1, Math.ceil(cy + r))
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(c.sw - 1, Math.ceil(cx + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue
        const i = y * c.sw + x
        const k = i * 3
        const j = i * 4
        // Repeated stamps along the path converge to the reference, never overshoot
        virtual[k] = virtual[k]! + (ref[j]! - virtual[k]!) * a
        virtual[k + 1] = virtual[k + 1]! + (ref[j + 1]! - virtual[k + 1]!) * a
        virtual[k + 2] = virtual[k + 2]! + (ref[j + 2]! - virtual[k + 2]!) * a
      }
    }
  }
}

function planLayer(
  c: PlanCtx,
  L: LayerSpec,
  level: number,
  ref: Uint8ClampedArray,
  virtual: Float32Array,
  limit: number,
): Stroke[] {
  const { sw, sh } = c
  const cell = Math.max(2, Math.round(L.width * c.s * 0.5 * c.ss))
  const cols = Math.ceil(sw / cell)
  const rows = Math.ceil(sh / cell)

  const errorOf = (col: number, row: number): { mean: number; worst: number } => {
    let sum = 0
    let n = 0
    let best = -1
    let worst = 0
    for (let y = row * cell; y < Math.min(sh, (row + 1) * cell); y++) {
      for (let x = col * cell; x < Math.min(sw, (col + 1) * cell); x++) {
        const i = y * sw + x
        const e = Math.hypot(
          virtual[i * 3]! - ref[i * 4]!,
          virtual[i * 3 + 1]! - ref[i * 4 + 1]!,
          virtual[i * 3 + 2]! - ref[i * 4 + 2]!,
        )
        sum += e
        n++
        if (e > best) {
          best = e
          worst = i
        }
      }
    }
    return { mean: n ? sum / n : 0, worst }
  }

  const candidates: { col: number; row: number; err: number }[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const { mean } = errorOf(col, row)
      if (mean > L.threshold) candidates.push({ col, row, err: mean * rand(0.9, 1.1) })
    }
  }
  // Fix the most-wrong places first; later candidates may already be covered
  candidates.sort((a, b) => b.err - a.err)

  const out: Stroke[] = []
  for (const cand of candidates) {
    if (out.length >= limit) break
    const { mean, worst } = errorOf(cand.col, cand.row)
    if (mean <= L.threshold) continue
    const x = ((worst % sw) + 0.5) / c.ss
    const y = (Math.floor(worst / sw) + 0.5) / c.ss
    const st = traceStroke(c, L, level, ref, x, y)
    stamp(c, virtual, ref, st)
    out.push(st)
  }
  return out
}

/**
 * Order strokes like a working painter: always continue next to where the brush
 * is, starting each stroke from whichever end is closer (so strokes chain into
 * hatching runs rather than hopping across the canvas).
 */
function orderStrokes(list: Stroke[], start: { x: number; y: number }): Stroke[] {
  const remaining = list.slice()
  const out: Stroke[] = []
  let x = start.x
  let y = start.y
  while (remaining.length) {
    let best = 0
    let bestD = Infinity
    let flip = false
    for (let i = 0; i < remaining.length; i++) {
      const st = remaining[i]!
      const a = st.points[0]!
      const b = st.points[st.points.length - 1]!
      const da = (a.x - x) ** 2 + (a.y - y) ** 2
      const db = (b.x - x) ** 2 + (b.y - y) ** 2
      if (da < bestD) {
        bestD = da
        best = i
        flip = false
      }
      if (db < bestD) {
        bestD = db
        best = i
        flip = true
      }
    }
    const st = remaining.splice(best, 1)[0]!
    if (flip) reverseStroke(st)
    out.push(st)
    const end = st.points[st.points.length - 1]!
    x = end.x
    y = end.y
  }
  return out
}

// ---------------------------------------------------------------------------
// Sketch: trace the image's main contours into pencil lines
// ---------------------------------------------------------------------------

const NEIGHBOURS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
]

function planSketch(c: PlanCtx, sharp: Uint8ClampedArray, count: number): Stroke[] {
  const { sw: w, sh: h } = c
  const n = w * h
  const r = Math.max(1, Math.round(w / 320))
  // Blur away texture so only the shapes an artist would outline remain
  const lum = boxBlur(boxBlur(luminance(sharp, n), w, h, r), w, h, r)
  const { gx, gy } = sobel(lum, w, h)
  const mag = new Float32Array(n)
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(gx[i]!, gy[i]!)

  // Non-maximum suppression: keep only the crest of each edge
  const nms = new Float32Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]!
      if (m <= 0) continue
      let a = (Math.atan2(gy[i]!, gx[i]!) * 180) / Math.PI
      if (a < 0) a += 180
      let o: number
      if (a < 22.5 || a >= 157.5) o = 1
      else if (a < 67.5) o = w + 1
      else if (a < 112.5) o = w
      else o = w - 1
      if (m >= mag[i + o]! && m >= mag[i - o]!) nms[i] = m
    }
  }

  const mags: number[] = []
  for (let i = 0; i < n; i += 3) if (nms[i]! > 0) mags.push(nms[i]!)
  mags.sort((a, b) => a - b)
  const high = mags[Math.floor(mags.length * 0.88)] ?? Infinity
  const low = high * 0.4

  const visited = new Uint8Array(n)
  const walk = (start: number): number[] => {
    const path: number[] = []
    let cur = start
    let pdx = 0
    let pdy = 0
    for (;;) {
      const x = cur % w
      const y = Math.floor(cur / w)
      let next = -1
      let bestScore = -Infinity
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
        const j = ny * w + nx
        if (visited[j] || nms[j]! < low) continue
        // Prefer continuing straight: contours are smooth
        const score = (dx * pdx + dy * pdy) / Math.hypot(dx, dy) + nms[j]! / (high * 4)
        if (score > bestScore) {
          bestScore = score
          next = j
        }
      }
      if (next < 0) break
      visited[next] = 1
      pdx = (next % w) - x
      pdy = Math.floor(next / w) - y
      path.push(next)
      cur = next
    }
    return path
  }

  const order: number[] = []
  for (let i = 0; i < n; i++) if (nms[i]! >= high) order.push(i)
  order.sort((a, b) => nms[b]! - nms[a]!)

  const minPts = Math.max(8, Math.round(w / 60))
  const chains: { x: number; y: number }[][] = []
  for (const seed of order) {
    if (visited[seed]) continue
    visited[seed] = 1
    const fwd = walk(seed)
    const back = walk(seed)
    const idx = [...back.reverse(), seed, ...fwd]
    if (idx.length < minPts) continue
    // Smooth the pixel staircase and convert to canvas coordinates
    const pts: { x: number; y: number }[] = []
    for (let k = 0; k < idx.length; k += 2) {
      let sx = 0
      let sy = 0
      let m = 0
      for (let q = Math.max(0, k - 2); q <= Math.min(idx.length - 1, k + 2); q++) {
        sx += idx[q]! % w
        sy += Math.floor(idx[q]! / w)
        m++
      }
      pts.push({ x: (sx / m + 0.5) / c.ss, y: (sy / m + 0.5) / c.ss })
    }
    // An artist draws long contours as several strokes
    const maxPts = Math.max(6, Math.round((240 * c.s) / (2 / c.ss)))
    for (let k = 0; k < pts.length - 1; k += maxPts) {
      const piece = pts.slice(k, k + maxPts + 1)
      if (piece.length >= 3) chains.push(piece)
    }
  }

  const lengthOf = (p: { x: number; y: number }[]) => {
    let L = 0
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y)
    return L
  }
  chains.sort((a, b) => lengthOf(b) - lengthOf(a))
  const chosen = chains.slice(0, count)

  const graphite: RGB = [62, 56, 50]
  const strokes = chosen.map((pts) => {
    // A hand-drawn line wavers a little
    const phase = rand(0, Math.PI * 2)
    const { normals } = geometry(pts)
    const wavy = pts.map((p, i) => {
      const wob = Math.sin(i * 0.45 + phase) * 0.5
      return { x: p.x + normals[i]!.x * wob, y: p.y + normals[i]!.y * wob }
    })
    return buildStroke(c, wavy, rand(1.2, 1.9) * Math.max(1, c.s), shade(graphite, rand(-8, 8)), {
      alpha: rand(0.38, 0.55),
      kind: 'sketch',
      style: 'pencil',
      level: -1,
      tint: 1,
      mix: 0,
      dry: 0.45,
      speed: 420 * c.s,
      relief: 0,
    })
  })

  // Big defining contours first, then the smaller ones — each run kept local
  const split = Math.ceil(strokes.length * 0.35)
  const first = orderStrokes(strokes.slice(0, split), { x: c.W * 0.5, y: c.H * 0.3 })
  const last = first[first.length - 1]
  const end = last ? last.points[last.points.length - 1]! : { x: c.W / 2, y: c.H / 2 }
  return [...first, ...orderStrokes(strokes.slice(split), end)]
}

// ---------------------------------------------------------------------------
// The whole plan
// ---------------------------------------------------------------------------

export function planPainting(
  source: HTMLCanvasElement,
  W: number,
  H: number,
  breakSeconds: number,
): PaintPlan {
  const s = Math.min(W, H) / 800
  const sw = Math.max(1, Math.round(Math.min(640, W)))
  const sh = Math.max(1, Math.round((H / W) * sw))
  const filterOk = supportsFilter()

  const refs = LAYERS.map((L) => makeRef(source, W, H, L.sigma * s, filterOk))
  toneInPlace(refs[0]!)
  const samples = refs.map((r) => toSample(r, sw, sh))
  const sharp = toSample(source, sw, sh)

  const c: PlanCtx = { W, H, s, sw, sh, ss: sw / W, field: buildField(sharp, sw, sh) }

  const strokes: Stroke[] = []
  const phases: Phase[] = []
  const push = (kind: LayerKind, list: Stroke[]) => {
    if (!list.length) return
    phases.push({ kind, start: strokes.length, end: strokes.length + list.length, t0: 0, t1: 0 })
    strokes.push(...list)
  }

  push('sketch', planSketch(c, sharp, clamp(Math.round(breakSeconds * 0.5), 40, 300)))

  // Simulated canvas starts as bare gesso
  const virtual = new Float32Array(sw * sh * 3)
  for (let i = 0; i < sw * sh; i++) virtual.set(GESSO_RGB, i * 3)

  // ~5.5 strokes/sec of refinement keeps the hand near natural speed
  const budget = clamp(Math.round(breakSeconds * 5.5), 700, 6000)
  LAYERS.forEach((L, level) => {
    const limit = L.cover ? 4000 : Math.round(budget * L.share)
    const raw = planLayer(c, L, level, samples[level]!, virtual, limit)
    const last = strokes[strokes.length - 1]
    const from = last ? last.points[last.points.length - 1]! : { x: W / 2, y: H / 2 }
    push(L.kind, orderStrokes(raw, from))
  })

  timePhases(phases, strokes, { x: W * 0.95, y: H * 1.1 })
  return { strokes, phases, refs }
}

/**
 * Give each phase a share of the painting time proportional to how long the hand
 * naturally needs for it, so the pace stays even from sketch to detail.
 */
function timePhases(phases: Phase[], strokes: Stroke[], start: { x: number; y: number }): void {
  let prev = start
  const weights = phases.map((ph) => {
    let sum = 0
    for (let i = ph.start; i < ph.end; i++) {
      const st = strokes[i]!
      const p0 = st.points[0]!
      sum += travelSec(Math.hypot(p0.x - prev.x, p0.y - prev.y), st) + downSec(st) + strokeSec(st) + liftSec(st)
      prev = st.points[st.points.length - 1]!
    }
    return sum
  })
  let total = weights.reduce((a, b) => a + b, 0) || 1
  // Keep the sketch a recognisable but brief opening act
  const si = phases.findIndex((p) => p.kind === 'sketch')
  if (si >= 0) {
    const others = total - weights[si]!
    const share = clamp(weights[si]! / total, 0.06, 0.14)
    weights[si] = (share / (1 - share)) * others
    total = others + weights[si]!
  }
  let t = 0
  phases.forEach((ph, i) => {
    ph.t0 = t
    t += weights[i]! / total
    ph.t1 = t
  })
  const lastPhase = phases[phases.length - 1]
  if (lastPhase) lastPhase.t1 = 1
}

/** Stroke index the painting should have reached at painting progress p (0..1). */
export function targetIndex(phases: Phase[], total: number, p: number): number {
  for (const ph of phases) {
    if (p < ph.t1) {
      const f = clamp((p - ph.t0) / Math.max(1e-6, ph.t1 - ph.t0), 0, 1)
      return ph.start + f * (ph.end - ph.start)
    }
  }
  return total
}
