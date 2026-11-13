import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaintStage } from '../components/PaintingReveal'
import { AmbientMusic } from '../lib/ambientMusic'

const PREF_KEY = 'atelier-music'
/** How far ahead notes are scheduled; covers timers throttled in background tabs */
const LOOKAHEAD_S = 2

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch {
    // Private mode etc.: the choice just won't persist
  }
}

type Options = {
  /** The break (painting) is on screen */
  active: boolean
  /** The timer is running (not paused) */
  running: boolean
  stage: PaintStage
  /** The narrator is talking: the music dips under the voice */
  speaking: boolean
}

/**
 * Soft generative background music while the painting is made. It fades in with
 * the break, follows the painting's stages, pauses with the timer, dips under the
 * narration and fades out when the break ends.
 */
export function useAmbientMusic({ active, running, stage, speaking }: Options) {
  const supported = typeof window !== 'undefined' && 'AudioContext' in window
  const [enabled, setEnabled] = useState(readPref)
  const ctxRef = useRef<AudioContext | null>(null)
  const musicRef = useRef<AmbientMusic | null>(null)
  // Latest values, for creating the music mid-stage
  const stageRef = useRef(stage)
  const speakingRef = useRef(speaking)
  stageRef.current = stage
  speakingRef.current = speaking

  // Browsers only allow audio that a user gesture started: create the context on
  // the first click or key press (e.g. "Begin focus"), then keep it asleep until
  // the break
  useEffect(() => {
    if (!supported) return
    const unlock = () => {
      if (ctxRef.current) return
      try {
        const ctx = new AudioContext({ latencyHint: 'playback' })
        ctxRef.current = ctx
        if (!musicRef.current) void ctx.suspend().catch(() => undefined)
      } catch {
        // No audio output available
      }
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    return () => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }, [supported])

  const fadeOut = useCallback(() => {
    const music = musicRef.current
    const ctx = ctxRef.current
    if (!music || !ctx) return
    musicRef.current = null
    if (ctx.state !== 'running') {
      music.dispose()
      return
    }
    const end = music.stop()
    window.setTimeout(
      () => {
        music.dispose()
        // Nothing else playing: let the audio hardware rest
        if (!musicRef.current) void ctx.suspend().catch(() => undefined)
      },
      Math.max(0, end - ctx.currentTime) * 1000 + 100,
    )
  }, [])

  // Start with the break, follow pause/resume, end with the break
  useEffect(() => {
    const ctx = ctxRef.current
    if (!supported || !enabled || !active || !ctx) {
      fadeOut()
      return
    }
    if (!musicRef.current) {
      const music = new AmbientMusic(ctx)
      music.setStage(stageRef.current ?? 'sketch')
      music.setSpeaking(speakingRef.current)
      music.start()
      musicRef.current = music
    }
    // Suspending the context freezes audio time, so the music pauses mid-note
    if (running) void ctx.resume().catch(() => undefined)
    else void ctx.suspend().catch(() => undefined)
  }, [supported, enabled, active, running, fadeOut])

  // Keep notes scheduled a little ahead of the audio clock
  useEffect(() => {
    if (!active || !enabled) return
    const id = window.setInterval(() => {
      const ctx = ctxRef.current
      if (ctx?.state === 'running') musicRef.current?.scheduleUntil(ctx.currentTime + LOOKAHEAD_S)
    }, 250)
    return () => window.clearInterval(id)
  }, [active, enabled])

  useEffect(() => {
    musicRef.current?.setStage(stage ?? 'sketch')
  }, [stage])

  useEffect(() => {
    musicRef.current?.setSpeaking(speaking)
  }, [speaking])

  // Leaving the page: stop everything
  useEffect(
    () => () => {
      musicRef.current?.dispose()
      musicRef.current = null
      void ctxRef.current?.close().catch(() => undefined)
      ctxRef.current = null
    },
    [],
  )

  const toggle = useCallback(() => {
    setEnabled((on) => {
      const next = !on
      writePref(next)
      return next
    })
  }, [])

  return { supported, enabled, toggle }
}
