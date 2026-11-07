import { useCallback, useEffect, useRef, useState } from 'react'

export type Phase = 'idle' | 'focus' | 'shortBreak' | 'longBreak'

const fast =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('fast') === '1'

const FOCUS_MS = fast ? 30 * 1000 : 25 * 60 * 1000
const SHORT_BREAK_MS = fast ? 20 * 1000 : 5 * 60 * 1000
const LONG_BREAK_MS = fast ? 40 * 1000 : 15 * 60 * 1000
const FOCUSES_BEFORE_LONG = 4

function durationFor(phase: Phase): number {
  switch (phase) {
    case 'focus':
      return FOCUS_MS
    case 'shortBreak':
      return SHORT_BREAK_MS
    case 'longBreak':
      return LONG_BREAK_MS
    default:
      return 0
  }
}

function nextAfterFocus(completedFocuses: number): Phase {
  return completedFocuses % FOCUSES_BEFORE_LONG === 0
    ? 'longBreak'
    : 'shortBreak'
}

export type PomodoroState = {
  phase: Phase
  remainingMs: number
  durationMs: number
  running: boolean
  completedFocuses: number
  /** Length of the break in progress, or of the one that follows this focus session */
  upcomingBreakMs: number
  progress: number
  start: () => void
  pause: () => void
  resume: () => void
  skip: () => void
  stop: () => void
  isBreak: boolean
}

export function usePomodoro(): PomodoroState {
  const [phase, setPhase] = useState<Phase>('idle')
  const [remainingMs, setRemainingMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [running, setRunning] = useState(false)
  const [completedFocuses, setCompletedFocuses] = useState(0)

  const phaseRef = useRef(phase)
  const remainingRef = useRef(remainingMs)
  const runningRef = useRef(running)
  const completedRef = useRef(completedFocuses)
  const lastTickRef = useRef<number | null>(null)
  const advancingRef = useRef(false)

  phaseRef.current = phase
  remainingRef.current = remainingMs
  runningRef.current = running
  completedRef.current = completedFocuses

  const enterPhase = useCallback((next: Phase) => {
    const duration = durationFor(next)
    phaseRef.current = next
    setPhase(next)
    setDurationMs(duration)
    setRemainingMs(duration)
    remainingRef.current = duration
    setRunning(next !== 'idle')
    lastTickRef.current = null
  }, [])

  const advanceFrom = useCallback(
    (current: Phase) => {
      if (advancingRef.current) return
      if (phaseRef.current !== current) return
      advancingRef.current = true
      try {
        if (current === 'focus') {
          const nextCount = completedRef.current + 1
          setCompletedFocuses(nextCount)
          completedRef.current = nextCount
          enterPhase(nextAfterFocus(nextCount))
          return
        }
        if (current === 'shortBreak' || current === 'longBreak') {
          enterPhase('focus')
        }
      } finally {
        advancingRef.current = false
      }
    },
    [enterPhase],
  )

  useEffect(() => {
    if (!running || phase === 'idle') return

    const id = window.setInterval(() => {
      const now = performance.now()
      if (lastTickRef.current == null) {
        lastTickRef.current = now
        return
      }
      const delta = now - lastTickRef.current
      lastTickRef.current = now
      const next = Math.max(0, remainingRef.current - delta)
      remainingRef.current = next
      setRemainingMs(next)
      if (next <= 0) {
        advanceFrom(phaseRef.current)
      }
    }, 200)

    return () => window.clearInterval(id)
  }, [running, phase, advanceFrom])

  const start = useCallback(() => {
    setCompletedFocuses(0)
    completedRef.current = 0
    enterPhase('focus')
  }, [enterPhase])

  const pause = useCallback(() => {
    setRunning(false)
    lastTickRef.current = null
  }, [])

  const resume = useCallback(() => {
    if (phaseRef.current === 'idle') return
    setRunning(true)
    lastTickRef.current = null
  }, [])

  const skip = useCallback(() => {
    if (phaseRef.current === 'idle') return
    advanceFrom(phaseRef.current)
  }, [advanceFrom])

  const stop = useCallback(() => {
    setPhase('idle')
    setRemainingMs(0)
    setDurationMs(0)
    setRunning(false)
    lastTickRef.current = null
  }, [])

  const progress =
    durationMs > 0 ? 1 - remainingMs / durationMs : 0

  return {
    phase,
    remainingMs,
    durationMs,
    running,
    completedFocuses,
    upcomingBreakMs:
      phase === 'shortBreak' || phase === 'longBreak'
        ? durationMs
        : durationFor(nextAfterFocus(completedFocuses + 1)),
    progress: Math.min(1, Math.max(0, progress)),
    start,
    pause,
    resume,
    skip,
    stop,
    isBreak: phase === 'shortBreak' || phase === 'longBreak',
  }
}

export function formatTime(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
