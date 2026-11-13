import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { nextPhrase, type PhraseContext } from '../lib/studioPhrases'

/** Each word with the index of its first letter in the line (for staggering) */
function words(text: string): { word: string; start: number }[] {
  let start = 0
  return text.split(' ').map((word) => {
    const w = { word, start }
    start += word.length + 1
    return w
  })
}

function newSeed(): number {
  return Math.floor(Math.random() * 1000)
}

/**
 * A dry-brush stroke of paint laid down behind the words, left to right, in step
 * with the letters: ragged edges, bristle streaks, and a different texture each
 * time (the noise seed changes per line).
 */
function PaintSwash({ seed, durationMs }: { seed: number; durationMs: number }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className="studio-chatter__swash" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden>
      <defs>
        <filter id={`dry-${id}`} x="-5%" y="-40%" width="110%" height="180%">
          {/* Long horizontal grain: the bristles drag along the stroke */}
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.45" numOctaves={2} seed={seed} result="grain" />
          {/* Ragged edges where the brush runs dry */}
          <feDisplacementMap in="SourceGraphic" in2="grain" scale={9} xChannelSelector="R" yChannelSelector="G" result="ragged" />
          {/* Streaks of bare canvas between the bristles */}
          <feColorMatrix
            in="grain"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.2 0 0 0 -0.95"
            result="streaks"
          />
          <feComposite in="ragged" in2="streaks" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#dry-${id})`}>
        {/* Loaded with paint at the start, thinning as it goes */}
        <path
          className="studio-chatter__swash-body"
          d="M8 22 C 70 15, 150 26, 222 19 S 282 18, 293 21"
          pathLength={1}
          style={{ animationDuration: `${durationMs}ms` }}
        />
        <path
          className="studio-chatter__swash-edge"
          d="M14 13 C 90 9, 170 16, 288 12"
          pathLength={1}
          style={{ animationDuration: `${durationMs * 0.9}ms` }}
        />
      </g>
    </svg>
  )
}

/** Delay between letters appearing */
const LETTER_MS = 26
/** Once the sentence is fully written, it stays still this long to be read (3s) */
const HOLD_MS = 3000
/** The drift-away at the end (matches chatter-out in StudioLoader.css) */
const OUT_MS = 450

/** When the line is fully written: the last letter's delay plus its 0.6s brush-in */
function revealMs(text: string): number {
  return text.length * LETTER_MS + 600
}

/**
 * A changing line from the studio, written in letter by letter with a brush
 * stroke sweeping underneath. Decorative: the loader announces its real status
 * to assistive tech separately.
 */
export function StudioChatter(ctx: PhraseContext) {
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const recent = useRef<string[]>([])
  const [line, setLine] = useState(() => {
    const first = nextPhrase(ctx, [])
    recent.current = [first]
    return { text: first, n: 0, seed: newSeed() }
  })

  // Each line gets its own time: longer sentences take longer to write
  useEffect(() => {
    const id = window.setTimeout(() => {
      const text = nextPhrase(ctxRef.current, recent.current)
      recent.current = [text, ...recent.current].slice(0, 8)
      setLine((l) => ({ text, n: l.n + 1, seed: newSeed() }))
    }, revealMs(line.text) + HOLD_MS + OUT_MS)
    return () => window.clearTimeout(id)
  }, [line])

  return (
    <p className="studio-chatter" aria-hidden>
      {/* key: a new line remounts, replaying the animation */}
      <span
        key={line.n}
        className="studio-chatter__line"
        // Drift away only after the full sentence has been readable for HOLD_MS
        style={{ animationDelay: `${revealMs(line.text) + HOLD_MS}ms` }}
      >
        <span className="studio-chatter__text">
          {words(line.text).map(({ word, start }, w) => (
            // Letters animate one by one, but a word never breaks across lines
            <Fragment key={w}>
              {w > 0 && ' '}
              <span className="studio-chatter__word">
                {[...word].map((ch, i) => (
                  <span key={i} className="studio-chatter__ch" style={{ animationDelay: `${(start + i) * LETTER_MS}ms` }}>
                    {ch}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
          <span className="studio-chatter__dots" style={{ animationDelay: `${line.text.length * LETTER_MS}ms` }}>
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </span>
        <PaintSwash seed={line.seed} durationMs={line.text.length * LETTER_MS + 450} />
      </span>
    </p>
  )
}
