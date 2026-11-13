/** Kokoro voices (American and British English). Shared by the app and vite.config.ts. */
export const VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
] as const

export type Voice = (typeof VOICES)[number]

/** Default narrator; override with NARRATION_VOICE in .env */
export const DEFAULT_VOICE: Voice = 'af_bella'

export function isVoice(voice: string): voice is Voice {
  return (VOICES as readonly string[]).includes(voice)
}
