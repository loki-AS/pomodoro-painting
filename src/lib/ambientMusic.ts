/**
 * Quiet generative music for the painting break, made live with the Web Audio
 * API: a slow, warm pad under sparse soft-piano notes, in a hall-like reverb.
 * Nothing is downloaded or licensed, and it never plays out the same way twice.
 *
 * It follows the painting: just the pad while the sketch goes down, a bass line
 * and occasional notes as the paint is blocked in, small phrases through the
 * detail, and a resolving arpeggio when the picture is finished. It dips under
 * the narrator's voice and swells back between lines.
 *
 * Events are scheduled ahead in audio time (scheduleUntil), so suspending the
 * AudioContext pauses the music cleanly, and the same engine can render offline.
 */

export type MusicStage =
  | 'sketch' | 'tone' | 'block' | 'form' | 'refine' | 'detail' | 'finish' | 'complete' | null

type Chord = { bass: number; notes: number[] }

/** A slow, open progression: Fmaj7 · Am7 · Dm9 · Cadd9 (MIDI notes) */
const PROGRESSION: Chord[] = [
  { bass: 41, notes: [53, 57, 60, 64] },
  { bass: 45, notes: [57, 60, 64, 67] },
  { bass: 38, notes: [53, 57, 60, 64] },
  { bass: 36, notes: [52, 55, 60, 62] },
]
/** Where it comes to rest when the painting is finished: F with an added ninth */
const RESOLUTION: Chord = { bass: 41, notes: [53, 57, 60, 67] }
/** C major pentatonic, E4–C6: sits over every chord above */
const MELODY = [64, 67, 69, 72, 74, 76, 79, 81, 84]

const CHORD_SECONDS = 12

/** How busy the music is at each stage of the painting */
const DENSITY: Record<Exclude<MusicStage, null>, { gap: [number, number]; phrase: number; bass: boolean; pad: number }> = {
  sketch:   { gap: [5, 8], phrase: 0, bass: false, pad: 0.8 },
  tone:     { gap: [4.5, 7], phrase: 0, bass: true, pad: 0.9 },
  block:    { gap: [3.5, 6], phrase: 0.15, bass: true, pad: 1 },
  form:     { gap: [3, 5], phrase: 0.3, bass: true, pad: 1 },
  refine:   { gap: [2.5, 4.5], phrase: 0.4, bass: true, pad: 1 },
  detail:   { gap: [2.5, 4.5], phrase: 0.4, bass: true, pad: 1 },
  finish:   { gap: [3, 5], phrase: 0.3, bass: true, pad: 1 },
  complete: { gap: [6, 9], phrase: 0, bass: true, pad: 0.85 },
}

const VOLUME = 0.3
/** Music level while the narrator speaks (relative): ~18 dB under the Kokoro voice */
const DUCKED = 0.3

function hz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

/** A hall-like reverb tail: decaying stereo noise, a little darker as it fades */
function makeImpulse(ctx: BaseAudioContext, seconds = 4.5): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds)
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate
      const white = Math.random() * 2 - 1
      // One-pole low-pass that closes over time: the tail loses its sparkle
      const k = 0.6 - 0.45 * (t / seconds)
      lp += k * (white - lp)
      data[i] = lp * Math.exp(-t / 1.1)
    }
  }
  return ir
}

type PadVoice = { gain: GainNode; oscs: OscillatorNode[]; end: number }

export class AmbientMusic {
  private ctx: BaseAudioContext
  /** Fade in/out of the whole piece */
  private master: GainNode
  /** Dips under the narration */
  private duck: GainNode
  private padBus: GainNode
  private padFilter: BiquadFilterNode
  private pianoBus: GainNode
  private reverbSend: GainNode
  private nodes: AudioNode[] = []
  private lfo: OscillatorNode

  private stage: MusicStage = 'sketch'
  private nextChordAt = 0
  private chordIndex = 0
  private nextNoteAt = 0
  private resolvePending = false
  private resolved = false
  private lastNote = 72
  private pads: PadVoice[] = []
  private started = false
  private stopped = false

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx

    // A gentle safety limiter so overlapping voices can never clip
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -12
    limiter.knee.value = 10
    limiter.ratio.value = 6
    limiter.attack.value = 0.01
    limiter.release.value = 0.4
    limiter.connect(destination)

    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(limiter)

    this.duck = ctx.createGain()
    this.duck.gain.value = 1
    this.duck.connect(this.master)

    const reverb = ctx.createConvolver()
    reverb.buffer = makeImpulse(ctx)
    const wet = ctx.createGain()
    wet.gain.value = 0.55
    reverb.connect(wet).connect(this.duck)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 1
    this.reverbSend.connect(reverb)

    // Pad: soft triangle voices through a slowly breathing low-pass
    this.padFilter = ctx.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = 900
    this.padFilter.Q.value = 0.4
    this.lfo = ctx.createOscillator()
    this.lfo.frequency.value = 0.045
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 350
    this.lfo.connect(lfoDepth).connect(this.padFilter.frequency)
    this.padBus = ctx.createGain()
    this.padBus.gain.value = 0.8
    this.padBus.connect(this.padFilter)
    this.padFilter.connect(this.duck)
    const padSend = ctx.createGain()
    padSend.gain.value = 0.5
    this.padFilter.connect(padSend).connect(this.reverbSend)

    // Piano: dry signal plus a generous reverb send
    this.pianoBus = ctx.createGain()
    this.pianoBus.gain.value = 1
    const pianoTone = ctx.createBiquadFilter()
    pianoTone.type = 'lowpass'
    pianoTone.frequency.value = 3200
    this.pianoBus.connect(pianoTone)
    pianoTone.connect(this.duck)
    const pianoSend = ctx.createGain()
    pianoSend.gain.value = 0.8
    pianoTone.connect(pianoSend).connect(this.reverbSend)

    this.nodes.push(limiter, this.master, this.duck, reverb, wet, this.reverbSend, this.padFilter, lfoDepth, this.padBus, padSend, this.pianoBus, pianoTone, pianoSend)
  }

  /** Begin at audio time `at`, fading in over a few seconds */
  start(at = this.ctx.currentTime): void {
    if (this.started) return
    this.started = true
    this.lfo.start(at)
    this.master.gain.setValueAtTime(0, at)
    this.master.gain.setTargetAtTime(VOLUME, at, 1.6)
    this.nextChordAt = at + 0.1
    this.nextNoteAt = at + rand(3, 5)
  }

  /** Fade out and end; returns the audio time when it is silent */
  stop(at = this.ctx.currentTime, fade = 2.5): number {
    if (this.stopped) return at
    this.stopped = true
    this.master.gain.cancelScheduledValues(at)
    this.master.gain.setTargetAtTime(0, at, fade / 4)
    const end = at + fade + 0.2
    for (const p of this.pads) for (const o of p.oscs) this.safeStop(o, end)
    this.safeStop(this.lfo, end)
    return end
  }

  /** Release every node (after stop()'s fade has finished) */
  dispose(): void {
    for (const p of this.pads) for (const o of p.oscs) this.safeStop(o)
    this.safeStop(this.lfo)
    for (const n of this.nodes) n.disconnect()
    this.pads = []
  }

  setStage(stage: MusicStage): void {
    if (stage === this.stage) return
    this.stage = stage
    if (stage === 'complete' && !this.resolved) this.resolvePending = true
  }

  /** Dip under the narrator's voice; come back up gently afterwards */
  setSpeaking(speaking: boolean, at = this.ctx.currentTime): void {
    this.duck.gain.cancelScheduledValues(at)
    this.duck.gain.setTargetAtTime(speaking ? DUCKED : 1, at, speaking ? 0.25 : 1.2)
  }

  /** Schedule everything that should start before audio time `until` */
  scheduleUntil(until: number): void {
    if (!this.started || this.stopped) return
    const density = DENSITY[this.stage ?? 'sketch']

    if (this.resolvePending) {
      this.resolvePending = false
      this.resolved = true
      // Come to rest now rather than at the next chord change
      const at = Math.max(this.ctx.currentTime + 0.3, until - 1)
      this.releasePads(at)
      this.playChord(RESOLUTION, at, 18, true)
      this.nextChordAt = at + 18
      this.chordIndex = 0
      this.arpeggio(at + 0.6)
      this.nextNoteAt = at + 8
    }

    while (this.nextChordAt < until) {
      const chord = PROGRESSION[this.chordIndex % PROGRESSION.length]!
      this.playChord(chord, this.nextChordAt, CHORD_SECONDS, density.bass, density.pad)
      this.nextChordAt += CHORD_SECONDS
      this.chordIndex++
    }

    while (this.nextNoteAt < until) {
      const t = this.nextNoteAt
      let busy = 0
      if (Math.random() < density.phrase) busy = this.phrase(t)
      else this.piano(this.nextMelodyNote(), t, rand(0.18, 0.28))
      // Leave room after a phrase
      this.nextNoteAt = t + busy + rand(density.gap[0], density.gap[1])
    }

    // Forget voices that have finished
    const now = this.ctx.currentTime
    this.pads = this.pads.filter((p) => p.end > now)
  }

  // -------------------------------------------------------------------------

  private safeStop(o: OscillatorNode, at?: number): void {
    try {
      o.stop(at)
    } catch {
      // not started, or already stopped
    }
  }

  /** Let the current chord fade from `at` (for an early change) */
  private releasePads(at: number): void {
    for (const p of this.pads) {
      if (p.end <= at) continue
      p.gain.gain.cancelScheduledValues(at)
      p.gain.gain.setTargetAtTime(0, at, 1.2)
      p.end = at + 7
      for (const o of p.oscs) this.safeStop(o, p.end)
    }
  }

  private playChord(chord: Chord, at: number, length: number, withBass: boolean, level = 1): void {
    const voices = chord.notes.map((n) => ({ midi: n, gain: 0.05 * level }))
    if (withBass) voices.push({ midi: chord.bass, gain: 0.07 * level })
    for (const v of voices) {
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      // Slow swell in, long release overlapping the next chord
      gain.gain.setTargetAtTime(v.gain, at, 1.4)
      gain.gain.setTargetAtTime(0, at + length - 0.5, 1.8)
      gain.connect(this.padBus)
      const end = at + length + 9
      const oscs: OscillatorNode[] = []
      for (const cents of [-5, 5]) {
        const o = this.ctx.createOscillator()
        o.type = 'triangle'
        o.frequency.value = hz(v.midi)
        o.detune.value = cents + rand(-2, 2)
        o.connect(gain)
        o.start(at)
        o.stop(end)
        oscs.push(o)
      }
      this.pads.push({ gain, oscs, end })
    }
  }

  /** A soft, felt-piano-like note: a few sine partials with a quick attack and long decay */
  private piano(midi: number, at: number, velocity: number): void {
    const f = hz(midi)
    const decay = 4.5 - (midi - 64) * 0.06
    const out = this.ctx.createGain()
    out.gain.value = 0
    out.gain.setValueAtTime(0, at)
    out.gain.linearRampToValueAtTime(velocity, at + 0.008)
    out.gain.setTargetAtTime(0, at + 0.008, decay / 4)
    out.connect(this.pianoBus)
    const end = at + decay + 0.5
    const partials: [number, number, number][] = [
      // ratio, level, decay factor (upper partials die away first)
      [1, 1, 1],
      [2.001, 0.28, 0.55],
      [3.003, 0.1, 0.35],
      [4.01, 0.04, 0.25],
    ]
    for (const [ratio, level, d] of partials) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f * ratio
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(level, at)
      g.gain.setTargetAtTime(0, at + 0.01, (decay * d) / 4)
      o.connect(g).connect(out)
      o.start(at)
      o.stop(end)
    }
  }

  /** Mostly small steps through the scale, so the notes sound like a line, not dice */
  private nextMelodyNote(): number {
    const i = MELODY.indexOf(this.lastNote)
    const from = i < 0 ? 3 : i
    const step = pick([-2, -1, -1, 1, 1, 2, 0, 3, -3])
    const next = MELODY[Math.max(0, Math.min(MELODY.length - 1, from + step))]!
    this.lastNote = next
    return next
  }

  /** A short run of notes; returns how long it lasts */
  private phrase(at: number): number {
    const count = pick([2, 3, 3, 4])
    let t = at
    for (let k = 0; k < count; k++) {
      this.piano(this.nextMelodyNote(), t, rand(0.14, 0.24) * (1 - k * 0.12))
      t += rand(0.35, 0.6)
    }
    return t - at
  }

  /** The closing gesture: a slow rising arpeggio over the resolving chord */
  private arpeggio(at: number): void {
    const notes = [65, 69, 72, 76, 79, 81]
    notes.forEach((n, k) => this.piano(n, at + k * 0.55, 0.22 - k * 0.015))
    this.lastNote = 81
  }
}
