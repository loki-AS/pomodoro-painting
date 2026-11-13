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
  /** Background music toggle; omitted when the browser can't play generated audio */
  music?: { enabled: boolean; onToggle: () => void }
  /** Still loading: the start buttons wait */
  disabled?: boolean
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
  music,
  disabled = false,
}: Props) {
  if (phase === 'idle') {
    return (
      <div className="controls">
        <button type="button" className="btn btn--primary" onClick={onStart} disabled={disabled} aria-busy={disabled}>
          Begin focus
        </button>
        <button type="button" className="btn btn--ghost" onClick={onFullscreen} disabled={disabled}>
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
      {music && (
        <button
          type="button"
          className="btn btn--ghost"
          aria-pressed={music.enabled}
          title={music.enabled ? 'Turn off background music' : 'Turn on background music'}
          onClick={music.onToggle}
        >
          {music.enabled ? 'Music on' : 'Music off'}
        </button>
      )}
    </div>
  )
}
