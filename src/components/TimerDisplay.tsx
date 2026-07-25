import { formatTime } from '../hooks/usePomodoro'
import './TimerDisplay.css'

type Props = {
  remainingMs: number
  label: string
  large?: boolean
}

export function TimerDisplay({ remainingMs, label, large }: Props) {
  return (
    <div className={`timer-display ${large ? 'timer-display--large' : ''}`}>
      <p className="timer-display__label">{label}</p>
      <p className="timer-display__time">{formatTime(remainingMs)}</p>
    </div>
  )
}
