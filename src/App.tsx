import { useCallback, useEffect, useRef, useState } from 'react'
import { ArtworkCredit } from './components/ArtworkCredit'
import { Controls } from './components/Controls'
import { FocusOverlay } from './components/FocusOverlay'
import { StudioLoader } from './components/StudioLoader'
import { PaintingReveal, type PaintStage } from './components/PaintingReveal'
import { useAmbientMusic } from './hooks/useAmbientMusic'
import { useNarration } from './hooks/useNarration'
import { useStudioReady } from './hooks/useStudioReady'
import { formatTime, usePomodoro } from './hooks/usePomodoro'
import { fetchRandomArtwork, type Artwork } from './lib/metApi'
import './index.css'

function breakLabel(phase: string): string {
  return phase === 'longBreak' ? 'Long rest' : 'Rest'
}

export default function App() {
  const pomo = usePomodoro()
  // The voice model and music engine, loaded before the first session can start
  const studio = useStudioReady()
  const [artwork, setArtwork] = useState<Artwork | null>(null)
  const [canvasReady, setCanvasReady] = useState(false)
  const [paintingDone, setPaintingDone] = useState(false)
  const [paintStage, setPaintStage] = useState<PaintStage>(null)
  const [preloadStatus, setPreloadStatus] = useState('')
  const [error, setError] = useState('')
  // Spoken commentary about the artwork while it is painted
  const narration = useNarration({
    artwork,
    active: pomo.isBreak,
    running: pomo.running,
    stage: paintStage,
  })
  // Soft background music under the painting, dipping when the narrator speaks
  const music = useAmbientMusic({
    active: pomo.isBreak,
    running: pomo.running,
    stage: paintStage,
    speaking: narration.speaking,
  })
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
      setCanvasReady(false)
      void preloadArtwork()
    }
  }, [pomo.phase, pomo.completedFocuses, preloadArtwork])

  useEffect(() => {
    if (pomo.isBreak && !artwork && !error) {
      setCanvasReady(false)
      void preloadArtwork()
    }
  }, [pomo.isBreak, artwork, error, preloadArtwork])

  useEffect(() => {
    if (pomo.phase === 'idle') {
      fetchGen.current += 1
      setArtwork(null)
      setCanvasReady(false)
      setPreloadStatus('')
      setError('')
    }
  }, [pomo.phase])

  useEffect(() => {
    if (!pomo.isBreak) setCanvasReady(false)
  }, [pomo.isBreak])

  const handleStart = () => {
    requestFullscreen()
    pomo.start()
  }

  // Credit the artist once the painting is finished and on show
  const showCredit = pomo.isBreak && paintingDone

  return (
    <div className={`app ${pomo.isBreak ? 'app--break' : ''}`}>
      <div className="app__atmosphere" aria-hidden />

      <PaintingReveal
        artwork={artwork}
        progress={pomo.isBreak ? pomo.progress : 0}
        durationMs={pomo.durationMs}
        breakMs={pomo.upcomingBreakMs}
        active={pomo.isBreak}
        onReadyChange={setCanvasReady}
        onCompleteChange={setPaintingDone}
        onStageChange={setPaintStage}
      />

      <ArtworkCredit
        artwork={artwork}
        visible={showCredit && canvasReady}
      />

      {pomo.phase !== 'idle' && (
        <p className="wordmark" aria-label="Atelier">
          Atelier
        </p>
      )}

      <main className="app__main">
        {pomo.phase === 'idle' && (
          <div className="idle">
            <h1 className="idle__brand">Atelier</h1>
            <p className="idle__tagline">
              Focus, then watch a Met painting appear stroke by stroke.
            </p>
            {studio.ready ? (
              <p className="idle__hint">25 · 5 · 15 · room display ready</p>
            ) : (
              <StudioLoader status={studio} />
            )}
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
              {error
                ? 'Could not load painting'
                : !artwork || !canvasReady
                  ? 'Loading canvas…'
                  : !pomo.running
                    ? 'Paused'
                    : paintingDone
                      ? 'Finished'
                      : 'Painting…'}
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
          disabled={!studio.ready}
          narration={narration.supported ? { enabled: narration.enabled, onToggle: narration.toggle } : undefined}
          music={music.supported ? { enabled: music.enabled, onToggle: music.toggle } : undefined}
        />
      </footer>
    </div>
  )
}
