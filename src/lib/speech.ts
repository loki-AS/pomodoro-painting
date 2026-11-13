/**
 * The natural narration voice, rendered in the browser by a Kokoro worker
 * (see ttsWorker.ts). No server and no key: the first narration downloads the
 * model once, and later visits load it from the browser cache.
 */
import type { TtsRequest, TtsResponse } from './ttsWorker'
import { DEFAULT_VOICE, isVoice, type Voice } from './voices'

/** Set from NARRATION_VOICE at build time (vite.config.ts) */
declare const __NARRATION_VOICE__: string

const VOICE: Voice = isVoice(__NARRATION_VOICE__) ? __NARRATION_VOICE__ : DEFAULT_VOICE

let worker: Worker | null = null
/** Once the model has failed to load or run, stop trying for this page */
let broken = false
/** The model has loaded and is rendering lines */
let ready = false
let nextId = 1
const waiting = new Map<number, (wav: ArrayBuffer | null) => void>()

function getWorker(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    broken = true
    return null
  }
  worker.onmessage = (e: MessageEvent<TtsResponse>) => {
    const msg = e.data
    if ('ready' in msg) {
      ready = true
      if (import.meta.env.DEV) console.info(`[tts] Kokoro ready in the browser (${msg.ready}, voice ${VOICE})`)
      return
    }
    const done = waiting.get(msg.id)
    waiting.delete(msg.id)
    if ('error' in msg) {
      console.warn('[tts] natural voice unavailable, using the browser voice:', msg.error)
      broken = true
      done?.(null)
    } else {
      done?.(msg.wav)
    }
  }
  worker.onerror = (e) => {
    console.warn('[tts] voice worker failed:', e.message)
    broken = true
    for (const done of waiting.values()) done(null)
    waiting.clear()
  }
  return worker
}

/** Speak `text` in the narrator's voice as a WAV blob, or null if the voice isn't available. */
export function synthesize(text: string): Promise<Blob | null> {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, (wav) => resolve(wav ? new Blob([wav], { type: 'audio/wav' }) : null))
    w.postMessage({ id, text, voice: VOICE } satisfies TtsRequest)
  })
}

/** True once the voice model has loaded, so a clip in progress is worth waiting for */
export function voiceReady(): boolean {
  return ready && !broken
}
