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

export type TtsRequest = { id: number; text: string; voice: Voice }
export type TtsResponse =
  | { id: number; wav: ArrayBuffer }
  | { id: number; error: string }
  | { ready: string }

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

declare const self: DedicatedWorkerGlobalScope

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function load(): Promise<KokoroTTS> {
  if (await hasWebGpu()) {
    try {
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu' })
      self.postMessage({ ready: 'webgpu' } satisfies TtsResponse)
      return tts
    } catch {
      // fall through to WebAssembly
    }
  }
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' })
  self.postMessage({ ready: 'wasm' } satisfies TtsResponse)
  return tts
}

let model: Promise<KokoroTTS> | null = null
// One line at a time: requests are queued by the message order anyway
let queue: Promise<unknown> = Promise.resolve()

self.onmessage = (e: MessageEvent<TtsRequest>) => {
  const { id, text, voice } = e.data
  queue = queue.then(async () => {
    try {
      model ??= load()
      const tts = await model
      const audio = await tts.generate(text, { voice })
      const wav = audio.toWav()
      self.postMessage({ id, wav } satisfies TtsResponse, [wav])
    } catch (err) {
      self.postMessage({ id, error: String(err) } satisfies TtsResponse)
    }
  })
}
