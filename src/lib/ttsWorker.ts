/// <reference lib="webworker" />
/**
 * Kokoro-82M text-to-speech (Hugging Face, Apache-2.0) running in the browser, in
 * its own thread so it never takes frames from the painting.
 *
 * The model downloads from Hugging Face on first use and the browser caches it.
 * WebGPU is used when the browser has it; otherwise WebAssembly with the 8-bit
 * model, which is smaller and quicker on a CPU.
 */
import { KokoroTTS } from 'kokoro-js'
import type { Voice } from './voices'

export type TtsRequest =
  /** Load (and warm up) the model ahead of time, reporting progress */
  | { type: 'load'; voice: Voice }
  | { type: 'speak'; id: number; text: string; voice: Voice }

export type TtsResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  /** A download attempt was abandoned (e.g. WebGPU failed): forget its progress */
  | { type: 'reset' }
  | { type: 'warming' }
  | { type: 'ready'; device: string }
  | { type: 'failed'; error: string }
  | { type: 'audio'; id: number; wav: ArrayBuffer }
  | { type: 'error'; id: number; error: string }

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

declare const self: DedicatedWorkerGlobalScope

const post = (msg: TtsResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

function progress(info: { status: string; file?: string; loaded?: number; total?: number }) {
  if (info.status === 'progress' && info.file) {
    post({ type: 'progress', file: info.file, loaded: info.loaded ?? 0, total: info.total ?? 0 })
  }
}

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function load(voice: Voice): Promise<KokoroTTS> {
  let tts: KokoroTTS | null = null
  let device = 'wasm'
  if (await hasWebGpu()) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu', progress_callback: progress })
      device = 'webgpu'
    } catch {
      post({ type: 'reset' })
    }
  }
  tts ??= await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback: progress })
  // A first short line fetches the voice and compiles the model, so the
  // narration's first real sentence isn't slow
  post({ type: 'warming' })
  await tts.generate('Ready.', { voice })
  post({ type: 'ready', device })
  return tts
}

let model: Promise<KokoroTTS> | null = null
// One job at a time, in the order received
let queue: Promise<unknown> = Promise.resolve()

function getModel(voice: Voice): Promise<KokoroTTS> {
  model ??= load(voice).catch((err: unknown) => {
    post({ type: 'failed', error: String(err) })
    throw err
  })
  return model
}

self.onmessage = (e: MessageEvent<TtsRequest>) => {
  const req = e.data
  if (req.type === 'load') {
    getModel(req.voice).catch(() => undefined)
    return
  }
  const { id, text, voice } = req
  queue = queue.then(async () => {
    try {
      const tts = await getModel(voice)
      const audio = await tts.generate(text, { voice })
      const wav = audio.toWav()
      post({ type: 'audio', id, wav }, [wav])
    } catch (err) {
      post({ type: 'error', id, error: String(err) })
    }
  })
}
