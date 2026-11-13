import type { StudioStatus } from '../hooks/useStudioReady'
import { StudioChatter } from './StudioChatter'
import './StudioLoader.css'

const MARK = { loading: '', ready: '✓', off: '–', unavailable: '·' } as const

/** What the studio is still preparing before the first session can start */
export function StudioLoader({ status }: { status: StudioStatus }) {
  const voice = status.steps.find((s) => s.key === 'voice')
  const pct = status.progress === null ? null : Math.round(status.progress * 100)
  return (
    <div className="studio-loader" role="status" aria-live="polite">
      <span className="visually-hidden">Preparing the studio</span>
      <StudioChatter
        voiceLoading={voice?.state === 'loading'}
        voiceWarming={voice?.detail === 'Warming up…' || voice?.detail === 'Setting up…'}
      />
      <div
        className={`studio-loader__bar ${pct === null ? 'studio-loader__bar--unknown' : ''}`}
        role="progressbar"
        aria-label="Loading"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <ul className="studio-loader__steps">
        {status.steps.map((s) => (
          <li key={s.key} className={`studio-loader__step studio-loader__step--${s.state}`}>
            <span className="studio-loader__mark" aria-hidden>
              {MARK[s.state]}
            </span>
            <span className="studio-loader__label">{s.label}</span>
            <span className="studio-loader__detail">{s.detail}</span>
          </li>
        ))}
      </ul>
      {status.firstDownload && (
        <p className="studio-loader__note">First visit only. It's saved for next time.</p>
      )}
    </div>
  )
}
