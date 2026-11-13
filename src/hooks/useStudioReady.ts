import { useEffect, useState } from 'react'
import { preloadVoice, type VoiceStatus } from '../lib/speech'

export type StepState = 'loading' | 'ready' | 'off' | 'unavailable'

export type StudioStep = {
  key: 'app' | 'voice' | 'music'
  label: string
  state: StepState
  detail: string
}

export type StudioStatus = {
  ready: boolean
  steps: StudioStep[]
  /** 0–1 across everything still loading, or null while the size isn't known yet */
  progress: number | null
  /** The voice is being downloaded for the first time (it is cached afterwards) */
  firstDownload: boolean
}

function narrationWanted(): boolean {
  try {
    return localStorage.getItem('atelier-narration') !== 'off'
  } catch {
    return true
  }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** Large downloads only happen on a first visit; cached loads are a few MB/s of disk reads */
const FIRST_DOWNLOAD_BYTES = 20_000_000

/**
 * Everything the break needs before the user can start: the app itself (already
 * running when this renders), the narrator's voice model, and the music engine.
 */
export function useStudioReady(): StudioStatus {
  const [wantVoice] = useState(narrationWanted)
  const [voice, setVoice] = useState<VoiceStatus>({ state: 'idle', loaded: 0, total: 0 })

  useEffect(() => {
    if (!wantVoice) return
    return preloadVoice(setVoice)
  }, [wantVoice])

  const musicSupported = typeof window !== 'undefined' && 'AudioContext' in window

  let voiceStep: StudioStep
  if (!wantVoice) {
    voiceStep = { key: 'voice', label: "Narrator's voice", state: 'off', detail: 'Narration is off' }
  } else if (voice.state === 'ready') {
    voiceStep = { key: 'voice', label: "Narrator's voice", state: 'ready', detail: 'Ready' }
  } else if (voice.state === 'unavailable') {
    voiceStep = { key: 'voice', label: "Narrator's voice", state: 'unavailable', detail: "Using your browser's voice" }
  } else if (voice.state === 'warming') {
    voiceStep = { key: 'voice', label: "Narrator's voice", state: 'loading', detail: 'Warming up…' }
  } else if (voice.total > 0 && voice.loaded >= voice.total) {
    // Downloaded; the model is being set up on the GPU/CPU (can take a little while)
    voiceStep = { key: 'voice', label: "Narrator's voice", state: 'loading', detail: 'Setting up…' }
  } else {
    voiceStep = {
      key: 'voice',
      label: "Narrator's voice",
      state: 'loading',
      detail: voice.total > 0 ? `${mb(voice.loaded)} of ${mb(voice.total)}` : 'Starting…',
    }
  }

  const steps: StudioStep[] = [
    { key: 'app', label: 'Studio', state: 'ready', detail: 'Ready' },
    voiceStep,
    musicSupported
      ? { key: 'music', label: 'Background music', state: 'ready', detail: 'Ready' }
      : { key: 'music', label: 'Background music', state: 'unavailable', detail: 'Not supported here' },
  ]

  const ready = steps.every((s) => s.state !== 'loading')
  let progress: number | null = null
  if (voiceStep.state === 'loading') {
    // Downloading is most of the wait; warming up takes the last few percent
    if (voice.state === 'warming') progress = 0.98
    else if (voice.total > 0 && voice.loaded >= voice.total) progress = 0.96
    else if (voice.total > 0) progress = Math.min(0.95, (voice.loaded / voice.total) * 0.95)
  } else {
    progress = 1
  }

  return { ready, steps, progress, firstDownload: voice.total > FIRST_DOWNLOAD_BYTES }
}
