/**
 * Server-side story generator for the narration (runs in Node, never in the
 * browser, so the API key stays private).
 *
 * The model looks at the painting itself and the facts we already hold (the Met's
 * catalogue record, plus Wikipedia text where it exists) and writes a short story
 * to be spoken while the painting is recreated on screen.
 */
import OpenAI from 'openai'

export type StoryRequest = {
  title: string
  artist: string
  date: string
  medium: string
  culture: string
  period: string
  department: string
  artistBio: string
  imageUrl: string
  /** Opening of the artwork's Wikipedia article, when one exists */
  artworkWiki?: string
  /** Opening of the artist's Wikipedia article, when one exists */
  artistWiki?: string
}

/** Default model; override with OPENAI_MODEL in .env.local */
export const DEFAULT_MODEL = 'gpt-5.5'

const SYSTEM_PROMPT = `You are the voice of a museum audio guide inside a focus timer. During the user's short break, a painting from The Metropolitan Museum of Art is recreated on screen stroke by stroke, and you tell them the story behind it.

Write about 90 to 120 words of warm, plain spoken English. It will be read aloud by a speech synthesizer, so write only the words to be spoken: no markdown, headings, lists, emoji or stage directions, and write dates and numbers the way they should be said. The listener has just heard the title, artist, date and medium, so don't repeat them; go straight into the story.

Ground every fact in the catalogue record and Wikipedia text you are given, and in what you can see in the image. Never invent names, dates, places, events, sitters' identities or provenance that the material doesn't support. When the record is thin, tell the story of what the picture shows and what its time and place suggest, and let interpretation sound like interpretation ("perhaps", "you can imagine"). End with one detail for the listener to watch for as the painting appears.`

/** Only The Met's own image host is accepted, so this can't be used to fetch arbitrary URLs. */
const IMAGE_HOST = 'https://images.metmuseum.org/'

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Validate and size-limit an incoming request body. Returns null if it isn't usable. */
export function parseStoryRequest(body: unknown): StoryRequest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const imageUrl = clip(b.imageUrl, 500)
  const title = clip(b.title, 300)
  if (!title || !imageUrl.startsWith(IMAGE_HOST)) return null
  return {
    title,
    imageUrl,
    artist: clip(b.artist, 200),
    date: clip(b.date, 100),
    medium: clip(b.medium, 300),
    culture: clip(b.culture, 100),
    period: clip(b.period, 100),
    department: clip(b.department, 100),
    artistBio: clip(b.artistBio, 300),
    artworkWiki: clip(b.artworkWiki, 2500),
    artistWiki: clip(b.artistWiki, 2500),
  }
}

function factsFor(r: StoryRequest): string {
  const record = [
    ['Title', r.title],
    ['Artist', r.artist],
    ['Artist details', r.artistBio],
    ['Date', r.date],
    ['Medium', r.medium],
    ['Culture', r.culture],
    ['Period', r.period],
    ['Met department', r.department],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')

  let text = `Catalogue record from The Metropolitan Museum of Art:\n${record}`
  if (r.artworkWiki) text += `\n\nWikipedia, about this artwork:\n${r.artworkWiki}`
  if (r.artistWiki) text += `\n\nWikipedia, about the artist:\n${r.artistWiki}`
  return `${text}\n\nTell the short story behind this painting.`
}

/** The model only needs a screen-sized view; the Met's originals can be tens of MB */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Fetch the painting ourselves and pass it inline. OpenAI's own download of Met
 * images sometimes times out, which would cost us the story. Prefers the Met's
 * smaller "web-large" rendition. Returns null if neither can be fetched.
 */
async function imageAsDataUrl(imageUrl: string): Promise<string | null> {
  const candidates = [imageUrl.replace('/original/', '/web-large/'), imageUrl]
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || !type.startsWith('image/')) continue
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES) continue
      return `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      // try the next rendition
    }
  }
  return null
}

/** Reasoning models take an effort setting; others reject the parameter */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model)
}

/**
 * Generate the story. Returns null when the model declines or the reply isn't
 * usable, so the app falls back to its catalogue-based narration. Throws on
 * API/network errors (the caller decides how to respond).
 */
export async function generateStory(client: OpenAI, r: StoryRequest, model = DEFAULT_MODEL): Promise<string | null> {
  // Fall back to letting OpenAI fetch the URL if we couldn't
  const image = (await imageAsDataUrl(r.imageUrl)) ?? r.imageUrl
  const response = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: 'user',
        content: [
          // 'auto' lets the model pick the resolution it needs to see the painting
          { type: 'input_image', image_url: image, detail: 'auto' },
          { type: 'input_text', text: factsFor(r) },
        ],
      },
    ],
    // Room for reasoning plus a ~120-word reply
    max_output_tokens: 4000,
    // A short creative piece: low effort keeps it quick
    ...(isReasoningModel(model) ? { reasoning: { effort: 'low' as const } } : {}),
  })

  if (response.status === 'incomplete') return null
  const text = response.output_text.trim()
  return text || null
}
