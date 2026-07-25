import './Controls.css'

type Props = {
  phase: 'idle' | 'focus' | 'shortBreak' | 'longBreak'
  running: boolean
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onSkip: () => void
  onStop: () => void
  onFullscreen: () => void
}

export function Controls({
  phase,
  running,
  onStart,
  onPause,
  onResume,
  onSkip,
  onStop,
  onFullscreen,
}: Props) {
  if (phase === 'idle') {
    return (
      <div className="controls">
        <button type="button" className="btn btn--primary" onClick={onStart}>
          Begin focus
        </button>
        <button type="button" className="btn btn--ghost" onClick={onFullscreen}>
          Fullscreen
        </button>
      </div>
    )
  }

  return (
    <div className="controls">
      {running ? (
        <button type="button" className="btn btn--primary" onClick={onPause}>
          Pause
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={onResume}>
          Resume
        </button>
      )}
      <button type="button" className="btn btn--ghost" onClick={onSkip}>
        Skip
      </button>
      <button type="button" className="btn btn--ghost" onClick={onStop}>
        Stop
      </button>
    </div>
  )
}
