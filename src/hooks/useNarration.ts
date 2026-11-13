import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaintStage } from '../components/PaintingReveal'
import type { Artwork } from '../lib/metApi'
import {
  Narrator,
  buildNarration,
  speechSupported,
  type NarrationCue,
  type NarrationScript,
} from '../lib/narration'

const PREF_KEY = 'atelier-narration'

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch {
    // Private mode etc.: the choice just won't persist
  }
}

/** Painting stages in order, so a cue can wait for "this stage or later" */
const STAGE_ORDER: Exclude<PaintStage, null>[] = [
  'sketch',
  'tone',
  'block',
  'form',
  'refine',
  'detail',
  'finish',
  'complete',
]

/** The stage at which each part of the narration begins */
function cueSchedule(script: NarrationScript): [NarrationCue, Exclude<PaintStage, null>][] {
  const plan: [NarrationCue, Exclude<PaintStage, null>][] = [
    ['opening', 'sketch'],
    ['context', 'block'],
  ]
  if (script.story) {
    plan.push(['story', 'form'], ['artist', 'refine'])
  } else {
    plan.push(['artist', 'form'])
  }
  plan.push(['closing', 'complete'])
  return plan
}

type Options = {
  artwork: Artwork | null
  /** The break (painting) is on screen */
  active: boolean
  /** The timer is running (not paused) */
  running: boolean
  stage: PaintStage
}

/**
 * Spoken commentary about the artwork while it is painted. The script is prepared
 * as soon as the artwork is known (during focus); each part is spoken when the
 * painting reaches its stage.
 */
export function useNarration({ artwork, active, running, stage }: Options) {
  const supported = speechSupported()
  const [enabled, setEnabled] = useState(readPref)
  const [script, setScript] = useState<{ id: number; lines: NarrationScript } | null>(null)
  const narratorRef = useRef<Narrator | null>(null)
  const spokenRef = useRef(new Set<NarrationCue>())

  const narrator = useCallback(() => {
    narratorRef.current ??= new Narrator()
    return narratorRef.current
  }, [])

  const objectID = artwork?.objectID ?? null

  // Prepare the script ahead of the break
  useEffect(() => {
    setScript(null)
    narratorRef.current?.clearClips()
    if (!artwork || !supported) return
    let cancelled = false
    void buildNarration(artwork).then((lines) => {
      if (cancelled) return
      setScript({ id: artwork.objectID, lines })
      // Render the natural (Kokoro) voice ahead of the break, in speaking order
      const order: NarrationCue[] = ['opening', 'context', 'story', 'artist', 'closing']
      void narrator().prepare(order.map((cue) => lines[cue] ?? '').filter(Boolean))
    })
    return () => {
      cancelled = true
    }
    // Rebuild only when the artwork itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectID, supported])

  // A new break or artwork starts the commentary afresh; leaving the break silences it
  useEffect(() => {
    spokenRef.current = new Set()
    if (!active) narratorRef.current?.stop()
  }, [active, objectID])

  // Stop speaking if the page goes away
  useEffect(() => () => narratorRef.current?.stop(), [])

  // Speak the part that belongs to the current stage
  useEffect(() => {
    if (!supported || !enabled || !active || !stage || !script || script.id !== objectID) return
    const now = STAGE_ORDER.indexOf(stage)
    const due = cueSchedule(script.lines).filter(
      ([cue, at]) => STAGE_ORDER.indexOf(at) <= now && !spokenRef.current.has(cue),
    )
    if (!due.length) return
    // Always introduce the painting; beyond that, if stages were skipped (e.g. after
    // pausing), jump to the latest part rather than reading a backlog
    const speak: NarrationCue[] = []
    if (due.some(([cue]) => cue === 'opening')) speak.push('opening')
    const latest = due[due.length - 1]![0]
    if (latest !== 'opening') speak.push(latest)
    for (const [cue] of due) spokenRef.current.add(cue)
    for (const cue of speak) narrator().say(script.lines[cue] ?? '')
  }, [supported, enabled, active, stage, script, objectID, narrator])

  // Follow the timer: pause speech with it, resume with it
  useEffect(() => {
    if (!active) return
    if (running) narratorRef.current?.resume()
    else narratorRef.current?.pause()
  }, [active, running])

  const toggle = useCallback(() => {
    setEnabled((on) => {
      const next = !on
      writePref(next)
      if (!next) narratorRef.current?.stop()
      return next
    })
  }, [])

  return { supported, enabled, toggle }
}
