import { useEffect, useRef } from 'react'

type Options = {
  /** Only applies while this is true (the painting break) */
  active: boolean
  running: boolean
  pause: () => void
  resume: () => void
}

/**
 * Pause while nobody can see the page (another tab, minimised window, locked
 * screen) and carry on when it's visible again, so the painting is never made
 * unseen. Only resumes a pause it made itself: a pause the user chose stays put.
 */
export function usePauseWhenHidden({ active, running, pause, resume }: Options) {
  const autoPaused = useRef(false)

  useEffect(() => {
    if (!active) {
      autoPaused.current = false
      return
    }
    // e.g. the break began while the page was already in the background
    if (running && document.hidden) {
      autoPaused.current = true
      pause()
    }
    const onVisibility = () => {
      if (document.hidden) {
        if (running) {
          autoPaused.current = true
          pause()
        }
      } else if (autoPaused.current) {
        autoPaused.current = false
        resume()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active, running, pause, resume])
}
