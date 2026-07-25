import { TimerDisplay } from './TimerDisplay'
import './FocusOverlay.css'

type Props = {
  remainingMs: number
  completedFocuses: number
  visible: boolean
}

export function FocusOverlay({ remainingMs, completedFocuses, visible }: Props) {
  return (
    <section
      className={`focus-overlay ${visible ? 'focus-overlay--visible' : ''}`}
      aria-hidden={!visible}
    >
      <TimerDisplay remainingMs={remainingMs} label="Focus" large />
      <p className="focus-overlay__sessions">
        Session {Math.min(completedFocuses + 1, 4)} of 4
      </p>
    </section>
  )
}
