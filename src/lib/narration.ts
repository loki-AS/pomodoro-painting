/**
 * Spoken narration for the painting break.
 *
 * Everything said comes from real sources: The Met's own catalogue details, plus
 * the opening of the English Wikipedia article for the artwork (when one exists)
 * or for the artist, and (when configured) a short AI-written story. It is spoken
 * by Kokoro running in the browser, with the browser's built-in voice as fallback.
 */
import type { Artwork } from './metApi'
import { synthesize, voiceReady } from './speech'

/** Moments in the painting where the narrator speaks */
export type NarrationCue = 'opening' | 'context' | 'story' | 'artist' | 'closing'

export type NarrationScript = Partial<Record<NarrationCue, string>>

// ---------------------------------------------------------------------------
// Wikipedia (via the Wikidata links the Met provides)
// ---------------------------------------------------------------------------

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

/** Opening paragraph of the English Wikipedia article linked from a Wikidata URL. */
async function wikipediaSummary(wikidataUrl: string, signal: AbortSignal): Promise<string> {
  const qid = wikidataUrl.match(/Q\d+/)?.[0]
  if (!qid) return ''
  const entity = (await fetchJson(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`,
    signal,
  )) as { entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }> }
  const title = entity.entities?.[qid]?.sitelinks?.enwiki?.title
  if (!title) return ''
  const summary = (await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    signal,
  )) as { type?: string; extract?: string }
  // Skip disambiguation pages and the like
  return summary.type === 'standard' ? (summary.extract ?? '') : ''
}

/** Make encyclopedia prose easier on the ear: drop parentheticals, keep a few sentences. */
function forSpeech(text: string, maxSentences: number): string {
  let t = text
  // Nested parentheses (pronunciations, alternative names, dates) read badly aloud
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\([^()]*\)/g, '')
  t = t.replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()
  return splitSentences(t).slice(0, maxSentences).join(' ')
}

export function splitSentences(text: string): string[] {
  // Split after . ! ? when followed by a capital, avoiding common abbreviations
  return text
    .replace(/\b(ca|c|St|Mr|Mrs|Dr|no|vol)\.\s/gi, '$1․ ')
    .split(/(?<=[.!?])\s+(?=[A-Z"“‘'])/)
    .map((s) => s.replace(/․/g, '.').trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/** Catalogue text made speakable: "ca. 1880–90" → "circa 1880 to 1890" */
function speakable(text: string): string {
  return (
    text
      .replace(/\bca\.\s*/gi, 'circa ')
      // "1880–90" → "1880 to 1890"; "1705–7" → "1705 to 1707"
      .replace(/\b(\d{4})\s*[–—-]\s*(\d{1,2})\b(?!\d)/g, (_, from: string, to: string) =>
        `${from} to ${from.slice(0, 4 - to.length)}${to}`,
      )
      .replace(/\s*[–—-]\s*(?=\d)/g, ' to ')
      // Catalogue parentheses ("Edo period (1615–1868)") read badly aloud
      .replace(/\s*\([^()]*\)/g, '')
      .replace(/;/g, ',')
      .trim()
  )
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s
}

function capFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** The Met sometimes records a country ("Japan") where speech wants an adjective ("Japanese") */
const CULTURE_ADJECTIVES: Record<string, string> = {
  japan: 'Japanese', china: 'Chinese', korea: 'Korean', india: 'Indian', france: 'French',
  italy: 'Italian', netherlands: 'Dutch', spain: 'Spanish', germany: 'German', egypt: 'Egyptian',
  iran: 'Iranian', mexico: 'Mexican', tibet: 'Tibetan', nepal: 'Nepalese', flanders: 'Flemish',
  england: 'English', britain: 'British', greece: 'Greek', russia: 'Russian', peru: 'Peruvian',
}

function cultureAdjective(culture: string): string {
  return CULTURE_ADJECTIVES[culture.toLowerCase()] ?? culture
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

/** "Oil on wood" → "oil on wood"; "Hanging scroll; ink on paper" → "a hanging scroll, ink on paper" */
function mediumPhrase(medium: string): string {
  const m = lowerFirst(speakable(medium))
  return /^(hanging scroll|handscroll|album leaf|folding screen|woodblock print|fan|panel|triptych|diptych)/.test(m)
    ? `${article(m)} ${m}`
    : m
}

function opening(a: Artwork): string {
  const by =
    !a.artist || /^(unknown|unidentified)/i.test(a.artist) ? 'by an unidentified artist' : `by ${a.artist}`
  const date = speakable(a.date)
  // "9th century" / "late 15th century" → "from the …"; "1889" → "from 1889"
  const when = date ? `, from ${/century|millennium/i.test(date) ? 'the ' : ''}${date}` : ''
  return `This is "${speakable(a.title)}", ${by}${when}.`
}

/**
 * "It's oil on wood. An American work, it belongs to the Met's American Wing collection."
 */
function context(a: Artwork): string {
  const sentences: string[] = []
  if (a.medium) sentences.push(`It's ${mediumPhrase(a.medium)}.`)

  const culture = cultureAdjective(speakable(a.culture))
  // "Late Republican" → "Late Republican period"; "Edo period" / "Tang dynasty" stay as they are
  const rawPeriod = speakable(a.period)
  const period = rawPeriod && !/(period|dynasty|era|age|kingdom|empire|style)$/i.test(rawPeriod) ? `${rawPeriod} period` : rawPeriod
  let origin = ''
  if (culture) origin = `${article(culture)} ${culture} work${period ? `, from the ${period}` : ''}`
  else if (period) origin = `a work from the ${period}`

  const department = a.department.replace(/^the\s+/i, '')
  const home = department ? `the Met's ${department} collection` : ''

  if (origin && home) sentences.push(`${capFirst(origin)}, it belongs to ${home}.`)
  else if (origin) sentences.push(`It's ${origin}.`)
  else if (home) sentences.push(`It belongs to ${home}.`)
  return sentences.join(' ')
}

function artistFromBio(a: Artwork): string {
  if (!a.artistBio || !a.artist || /^(unknown|unidentified)/i.test(a.artist)) return ''
  return `About the artist: ${a.artist}, ${speakable(a.artistBio)}.`
}

/**
 * Ask our server for the short story behind the painting (written by Claude from
 * the image and the facts we pass). Returns '' when the server isn't configured
 * or anything goes wrong, so narration falls back to catalogue and Wikipedia text.
 */
async function fetchStory(a: Artwork, artworkWiki: string, artistWiki: string, timeoutMs = 45000): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('/api/story', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        title: a.title,
        artist: a.artist,
        date: a.date,
        medium: a.medium,
        culture: a.culture,
        period: a.period,
        department: a.department,
        artistBio: a.artistBio,
        imageUrl: a.imageUrl,
        artworkWiki,
        artistWiki,
      }),
    })
    // 204: the story service isn't configured
    if (!res.ok || res.status === 204) return ''
    const data = (await res.json()) as { story?: unknown }
    return typeof data.story === 'string' ? data.story.trim() : ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the narration for an artwork: the Met's details, Wikipedia text where it
 * exists, and — when the story service is available — the short story behind the
 * painting. Every source is best-effort; the Met's own details always make a script.
 */
export async function buildNarration(a: Artwork, timeoutMs = 6000): Promise<NarrationScript> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const safe = (p: Promise<string>) => p.catch(() => '')
  const [artworkText, artistText] = await Promise.all([
    a.objectWikidataUrl ? safe(wikipediaSummary(a.objectWikidataUrl, ctrl.signal)) : Promise.resolve(''),
    a.artistWikidataUrl ? safe(wikipediaSummary(a.artistWikidataUrl, ctrl.signal)) : Promise.resolve(''),
  ])
  clearTimeout(timer)

  const story = await fetchStory(a, artworkText, artistText)

  return {
    opening: opening(a),
    context: context(a),
    // The written story already weaves in the artist, so it replaces both
    story: story || (artworkText ? forSpeech(artworkText, 3) : ''),
    artist: story ? '' : artistText ? forSpeech(artistText, 2) : artistFromBio(a),
    closing: `And there it is: "${speakable(a.title)}". Take a moment with it before your next session.`,
  }
}

// ---------------------------------------------------------------------------
// Narrator: speaks one sentence at a time from its own queue. Chrome can cut off
// long utterances, and pausing mid-utterance is unreliable across browsers, so a
// pause cancels the current sentence and a resume starts it again.
// ---------------------------------------------------------------------------

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang))
  if (!voices.length) return null
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online/i.test(v.name) ? 4 : 0) +
    (/google|microsoft|samantha|daniel|serena/i.test(v.name) ? 2 : 0) +
    (/en-GB/i.test(v.lang) ? 1 : 0)
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null
}

export class Narrator {
  private queue: string[] = []
  private speaking = false
  private paused = false
  private voice: SpeechSynthesisVoice | null = null
  /** Pre-rendered Kokoro audio per sentence (object URLs), prepared during focus */
  private clips = new Map<string, string>()
  /** The clip currently playing, if the current sentence has one */
  private audio: HTMLAudioElement | null = null
  /** Bumped by clearClips() so an in-flight prepare() stops adding stale clips */
  private generation = 0
  /** Told when the voice starts and stops (between lines, not between sentences) */
  onSpeakingChange: ((speaking: boolean) => void) | null = null
  private voiceOn = false

  private setVoiceOn(on: boolean): void {
    if (on === this.voiceOn) return
    this.voiceOn = on
    this.onSpeakingChange?.(on)
  }

  constructor() {
    if (!speechSupported()) return
    this.voice = pickVoice()
    // Voices often load asynchronously
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      this.voice = pickVoice()
    })
  }

  /** Sentences still being rendered, so playback can wait for them briefly */
  private rendering = new Set<string>()
  private onRendered: (() => void)[] = []

  /**
   * Render natural-voice audio for every sentence of these lines, in speaking
   * order, ahead of the break. Best-effort: if the voice can't load, those
   * sentences use the browser's own voice.
   */
  async prepare(lines: string[]): Promise<void> {
    const gen = this.generation
    const sentences = lines.flatMap((l) => splitSentences(l)).filter((s) => !this.clips.has(s))
    for (const s of sentences) this.rendering.add(s)
    try {
      for (const sentence of sentences) {
        if (gen !== this.generation) return
        const blob = await synthesize(sentence)
        if (gen !== this.generation) return
        this.rendering.delete(sentence)
        if (!blob) return
        this.clips.set(sentence, URL.createObjectURL(blob))
        this.rendered()
      }
    } finally {
      if (gen === this.generation) {
        this.rendering.clear()
        this.rendered()
      }
    }
  }

  private rendered(): void {
    const listeners = this.onRendered
    this.onRendered = []
    for (const fn of listeners) fn()
  }

  /** Forget prepared audio (a new artwork is coming) */
  clearClips(): void {
    this.generation++
    for (const url of this.clips.values()) URL.revokeObjectURL(url)
    this.clips.clear()
    this.rendering.clear()
    this.rendered()
  }

  say(text: string): void {
    if (!text) return
    this.queue.push(...splitSentences(text))
    this.next()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.setVoiceOn(false)
    if (!this.speaking) return
    if (this.audio) {
      // A clip pauses mid-sentence and picks up where it left off
      this.audio.pause()
      return
    }
    // Browser speech can't reliably pause: stop, and restart the sentence on resume
    this.speaking = false
    try {
      window.speechSynthesis.cancel()
    } catch {
      // ignore
    }
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.speaking && this.audio) {
      this.setVoiceOn(true)
      void this.audio.play().catch(() => this.finishSentence())
      return
    }
    this.next()
  }

  stop(): void {
    this.queue = []
    this.speaking = false
    this.setVoiceOn(false)
    if (this.audio) {
      this.audio.pause()
      this.audio = null
    }
    try {
      if (speechSupported()) window.speechSynthesis.cancel()
    } catch {
      // ignore: nothing left to stop
    }
  }

  private finishSentence(): void {
    if (!this.speaking) return
    this.speaking = false
    this.audio = null
    this.queue.shift()
    this.next()
  }

  private next(): void {
    if (!this.speaking && !this.paused && !this.queue.length) this.setVoiceOn(false)
    if (this.speaking || this.paused || !this.queue.length) return
    const sentence = this.queue[0]!

    const clip = this.clips.get(sentence)
    if (clip) {
      const audio = new Audio(clip)
      audio.onended = () => {
        if (this.audio === audio) this.finishSentence()
      }
      audio.onerror = () => {
        if (this.audio === audio) this.finishSentence()
      }
      this.audio = audio
      this.speaking = true
      this.setVoiceOn(true)
      // If playback is refused, move on rather than stall the narration
      void audio.play().catch(() => {
        if (this.audio === audio) this.finishSentence()
      })
      return
    }

    // Its clip is still rendering: wait for it (up to a few seconds) rather than
    // switch voices mid-narration. While the model is still downloading (first
    // visit), don't wait: use the browser voice straight away
    if (this.rendering.has(sentence) && voiceReady()) {
      this.speaking = true
      let settled = false
      const go = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!this.speaking || this.audio || this.queue[0] !== sentence) return
        this.speaking = false
        // Gave up waiting: speak it with the browser voice
        if (!this.clips.has(sentence)) this.rendering.delete(sentence)
        this.next()
      }
      const timer = setTimeout(go, 8000)
      const check = () => {
        if (this.clips.has(sentence) || !this.rendering.has(sentence)) go()
        else this.onRendered.push(check)
      }
      this.onRendered.push(check)
      return
    }

    if (!speechSupported()) {
      // No clip and no browser voice: skip this sentence
      this.queue.shift()
      this.next()
      return
    }
    const u = new SpeechSynthesisUtterance(sentence)
    if (this.voice) u.voice = this.voice
    u.lang = this.voice?.lang ?? 'en-GB'
    u.rate = 0.95
    u.pitch = 1
    const done = () => {
      // Ignore events from an utterance that pause/stop already cancelled
      if (!this.speaking || this.audio || this.queue[0] !== sentence) return
      this.finishSentence()
    }
    u.onend = done
    u.onerror = done
    this.speaking = true
    this.setVoiceOn(true)
    try {
      window.speechSynthesis.speak(u)
    } catch (err) {
      // Narration is a nicety: a speech-engine failure must never break the timer
      console.warn('[narration] speech failed', err)
      this.stop()
    }
  }
}
