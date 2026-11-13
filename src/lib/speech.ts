/**
 * The natural narration voice, rendered in the browser by a Kokoro worker
 * (see ttsWorker.ts). No server and no key: the first visit downloads the model
 * once, and later visits load it from the browser cache.
 */
import type { TtsRequest, TtsResponse } from './ttsWorker'
import { DEFAULT_VOICE, isVoice, type Voice } from './voices'

/** Set from NARRATION_VOICE at build time (vite.config.ts) */
declare const __NARRATION_VOICE__: string

const VOICE: Voice = isVoice(__NARRATION_VOICE__) ? __NARRATION_VOICE__ : DEFAULT_VOICE

export type VoiceStatus = {
  /** downloading → warming (first run) → ready, or unavailable (browser voice is used) */
  state: 'idle' | 'downloading' | 'warming' | 'ready' | 'unavailable'
  /** Bytes downloaded so far / expected (0 until known) */
  loaded: number
  total: number
}

let status: VoiceStatus = { state: 'idle', loaded: 0, total: 0 }
const listeners = new Set<(s: VoiceStatus) => void>()
const files = new Map<string, { loaded: number; total: number }>()

function setStatus(next: Partial<VoiceStatus>): void {
  status = { ...status, ...next }
  for (const fn of listeners) fn(status)
}

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, (wav: ArrayBuffer | null) => void>()

function fail(reason: string): void {
  if (status.state !== 'unavailable') console.warn('[tts] natural voice unavailable, using the browser voice:', reason)
  setStatus({ state: 'unavailable' })
  for (const done of waiting.values()) done(null)
  waiting.clear()
}

function getWorker(): Worker | null {
  if (status.state === 'unavailable') return null
  if (worker) return worker
  if (typeof Worker === 'undefined') {
    fail('Web Workers are not supported')
    return null
  }
  try {
    worker = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    fail(String(err))
    return null
  }
  worker.onmessage = (e: MessageEvent<TtsResponse>) => {
    const msg = e.data
    switch (msg.type) {
      case 'progress': {
        files.set(msg.file, { loaded: msg.loaded, total: msg.total })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        setStatus({ state: 'downloading', loaded, total })
        break
      }
      case 'reset':
        files.clear()
        setStatus({ loaded: 0, total: 0 })
        break
      case 'warming':
        setStatus({ state: 'warming' })
        break
      case 'ready':
        if (import.meta.env.DEV) console.info(`[tts] Kokoro ready in the browser (${msg.device}, voice ${VOICE})`)
        setStatus({ state: 'ready' })
        break
      case 'failed':
        fail(msg.error)
        break
      case 'audio':
      case 'error': {
        const done = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.type === 'error') fail(msg.error)
        else done?.(msg.wav)
        break
      }
    }
  }
  worker.onerror = (e) => fail(e.message || 'voice worker failed')
  return worker
}

/** Start loading the voice now (download + warm-up), and follow its progress. */
export function preloadVoice(onStatus: (s: VoiceStatus) => void): () => void {
  listeners.add(onStatus)
  const w = getWorker()
  if (w && status.state === 'idle') {
    setStatus({ state: 'downloading' })
    w.postMessage({ type: 'load', voice: VOICE } satisfies TtsRequest)
  }
  onStatus(status)
  return () => listeners.delete(onStatus)
}

/** True once the voice model has loaded, so a clip in progress is worth waiting for */
export function voiceReady(): boolean {
  return status.state === 'ready'
}

/** Speak `text` in the narrator's voice as a WAV blob, or null if the voice isn't available. */
export function synthesize(text: string): Promise<Blob | null> {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, (wav) => resolve(wav ? new Blob([wav], { type: 'audio/wav' }) : null))
    w.postMessage({ type: 'speak', id, text, voice: VOICE } satisfies TtsRequest)
  })
}
