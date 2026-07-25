import { useCallback, useEffect, useRef, useState } from 'react'
import { ArtworkCredit } from './components/ArtworkCredit'
import { Controls } from './components/Controls'
import { FocusOverlay } from './components/FocusOverlay'
import { PaintingReveal } from './components/PaintingReveal'
import { formatTime, usePomodoro } from './hooks/usePomodoro'
import { fetchRandomArtwork, type Artwork } from './lib/metApi'
import './index.css'

function breakLabel(phase: string): string {
  return phase === 'longBreak' ? 'Long rest' : 'Rest'
}

export default function App() {
  const pomo = usePomodoro()
  const [artwork, setArtwork] = useState<Artwork | null>(null)
  const [preloadStatus, setPreloadStatus] = useState('')
  const [error, setError] = useState('')
  const fetchGen = useRef(0)

  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.().catch(() => undefined)
    }
  }, [])

  const preloadArtwork = useCallback(async () => {
    const gen = ++fetchGen.current
    setPreloadStatus('Fetching a painting from The Met…')
    setError('')
    try {
      const next = await fetchRandomArtwork()
      if (gen !== fetchGen.current) return
      setArtwork(next)
      setPreloadStatus(`Ready: ${next.title}`)
    } catch (err) {
      if (gen !== fetchGen.current) return
      const message =
        err instanceof Error ? err.message : 'Failed to load painting'
      setError(message)
      setPreloadStatus('')
    }
  }, [])

  useEffect(() => {
    if (pomo.phase === 'focus') {
      setArtwork(null)
      void preloadArtwork()
    }
  }, [pomo.phase, pomo.completedFocuses, preloadArtwork])

  useEffect(() => {
    if (pomo.isBreak && !artwork && !error) {
      void preloadArtwork()
    }
  }, [pomo.isBreak, artwork, error, preloadArtwork])

  useEffect(() => {
    if (pomo.phase === 'idle') {
      fetchGen.current += 1
      setArtwork(null)
      setPreloadStatus('')
      setError('')
    }
  }, [pomo.phase])

  const handleStart = () => {
    requestFullscreen()
    pomo.start()
  }

  const showCredit = pomo.isBreak && pomo.progress >= 0.85

  return (
    <div className={`app ${pomo.isBreak ? 'app--break' : ''}`}>
      <div className="app__atmosphere" aria-hidden />

      <PaintingReveal
        artwork={artwork}
        progress={pomo.isBreak ? pomo.progress : 0}
        active={pomo.isBreak && !!artwork}
      />

      <ArtworkCredit artwork={artwork} visible={showCredit} />

      <main className="app__main">
        {pomo.phase === 'idle' && (
          <div className="idle">
            <h1 className="idle__brand">Atelier</h1>
            <p className="idle__tagline">
              Focus, then watch a Met painting appear stroke by stroke.
            </p>
            <p className="idle__hint">25 · 5 · 15 · room display ready</p>
          </div>
        )}

        {pomo.phase === 'focus' && (
          <FocusOverlay
            remainingMs={pomo.remainingMs}
            completedFocuses={pomo.completedFocuses}
            visible
          />
        )}

        {pomo.isBreak && (
          <div className="break-chrome">
            <p className="break-chrome__status">{breakLabel(pomo.phase)}</p>
            <p className="break-chrome__time">
              {formatTime(pomo.remainingMs)}
            </p>
            <p className="break-chrome__hint">
              {!artwork && !error
                ? 'Loading canvas…'
                : pomo.running
                  ? 'Painting…'
                  : 'Paused'}
            </p>
          </div>
        )}
      </main>

      <footer className="app__footer">
        {pomo.phase === 'focus' && (
          <p className={`status-line ${error ? 'status-line--error' : ''}`}>
            {error || preloadStatus}
          </p>
        )}
        {pomo.isBreak && error && (
          <p className="status-line status-line--error">{error}</p>
        )}
        <Controls
          phase={pomo.phase}
          running={pomo.running}
          onStart={handleStart}
          onPause={pomo.pause}
          onResume={pomo.resume}
          onSkip={pomo.skip}
          onStop={pomo.stop}
          onFullscreen={requestFullscreen}
        />
      </footer>
    </div>
  )
}
