/**
 * Little lines from the painter's studio, shown while the app gets ready.
 * Assembled from parts so they are rarely the same twice.
 */

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

const PIGMENTS = [
  'lapis lazuli', 'burnt sienna', 'yellow ochre', 'lead white', 'vermilion', 'raw umber',
  'verdigris', 'rose madder', 'Naples yellow', 'ivory black', 'smalt', 'malachite',
  'terre verte', 'red ochre', 'bone black', 'orpiment',
] as const

const PIGMENT_VERBS = ['Grinding', 'Mulling', 'Mixing', 'Warming', 'Tempering', 'Laying out', 'Thinning'] as const

/** Endings that suit each verb, so the lines stay sensible */
const PIGMENT_TAILS: Record<(typeof PIGMENT_VERBS)[number], readonly string[]> = {
  Grinding: ['', ' on the marble slab', ' to a fine powder', ' for the sky'],
  Mulling: ['', ' with linseed oil', ' on the glass slab', ' until it shines'],
  Mixing: ['', ' for the shadows', ' a little warmer', ' with a touch of white', ' for the first layer'],
  Warming: ['', ' for the flesh tones', ' with a little ochre'],
  Tempering: [' with egg yolk', ' for the underpainting'],
  'Laying out': [' on the palette', ' beside the white'],
  Thinning: [' with turpentine', ' for a glaze', ' for the sketch'],
}

const STUDIO = [
  'Stretching linen over the frame',
  'Laying a coat of gesso',
  'Sanding the gesso smooth',
  'Sharpening the charcoal',
  'Washing the sable brushes',
  'Opening the north window',
  'Turning the easel to the light',
  'Warming the linseed oil',
  'Scraping yesterday off the palette',
  'Choosing the softest hog bristle',
  'Squaring up the composition',
  'Tacking the canvas to the stretcher',
  'Dusting off the mahlstick',
  'Pouring a little poppy oil',
  'Letting the varnish settle',
  'Wiping the palette knife clean',
  'Waiting for the light to soften',
  'Toning the canvas a warm grey',
] as const

const VOICE_LINES = [
  'Waking the narrator',
  'The narrator is finding their notes',
  'The narrator clears their throat',
  'Handing the narrator the catalogue',
] as const

const WARMING_LINES = [
  'The narrator is warming up',
  'The narrator is trying a first word',
] as const

const MUSIC_LINES = ['Tuning the old piano', 'Finding a quiet key', 'Placing the gramophone needle'] as const

export type PhraseContext = { voiceLoading: boolean; voiceWarming: boolean }

/** A fresh line, avoiding the recent ones */
export function nextPhrase(ctx: PhraseContext, recent: readonly string[]): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const roll = Math.random()
    let line: string
    if (ctx.voiceWarming && roll < 0.35) line = pick(WARMING_LINES)
    else if (ctx.voiceLoading && roll < 0.15) line = pick(VOICE_LINES)
    else if (roll < 0.22) line = pick(MUSIC_LINES)
    else if (roll < 0.62) {
      const verb = pick(PIGMENT_VERBS)
      line = `${verb} ${pick(PIGMENTS)}${pick(PIGMENT_TAILS[verb])}`
    } else line = pick(STUDIO)
    if (!recent.includes(line)) return line
  }
  return pick(STUDIO)
}
