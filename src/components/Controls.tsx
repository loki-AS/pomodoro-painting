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
  /** Spoken commentary toggle; omitted when the browser has no speech support */
  narration?: { enabled: boolean; onToggle: () => void }
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
  narration,
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
      {narration && (
        <button
          type="button"
          className="btn btn--ghost"
          aria-pressed={narration.enabled}
          title={narration.enabled ? 'Turn off spoken commentary' : 'Turn on spoken commentary'}
          onClick={narration.onToggle}
        >
          {narration.enabled ? 'Narration on' : 'Narration off'}
        </button>
      )}
    </div>
  )
}
