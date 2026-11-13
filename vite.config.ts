import OpenAI, { APIError, AuthenticationError, RateLimitError } from 'openai'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { DEFAULT_MODEL, generateStory, parseStoryRequest } from './server/story.ts'
import { DEFAULT_VOICE, isVoice } from './src/lib/voices.ts'

/**
 * POST /api/story — the short spoken story behind a painting, written by an
 * OpenAI model.
 *
 * Runs inside the dev server so the API key stays on the server: it is read from
 * OPENAI_API_KEY (e.g. in .env.local, which git ignores) and is never sent to the
 * browser. Without a key the app uses its catalogue-based narration (the endpoint
 * answers 204). For a deployed build, host the same handler as a serverless
 * function (see server/story.ts).
 */
function storyApi(apiKey: string | undefined, model: string): Plugin {
  const cache = new Map<string, string>()
  let client: OpenAI | null = null

  return {
    name: 'atelier-story-api',
    configureServer(server) {
      server.middlewares.use('/api/story', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') return send(405, { error: 'POST only' })
        // Not configured is a normal setup, not an error: 204 tells the app to use its own narration
        if (!apiKey) {
          res.statusCode = 204
          return res.end()
        }

        let raw = ''
        req.on('data', (chunk: Buffer) => {
          raw += chunk
          if (raw.length > 20_000) req.destroy()
        })
        req.on('end', async () => {
          let parsed: ReturnType<typeof parseStoryRequest> = null
          try {
            parsed = parseStoryRequest(JSON.parse(raw))
          } catch {
            // falls through to 400
          }
          if (!parsed) return send(400, { error: 'Invalid story request' })

          // One story per artwork: repeat requests are free
          const cached = cache.get(parsed.imageUrl)
          if (cached) return send(200, { story: cached })

          try {
            client ??= new OpenAI({ apiKey })
            const story = await generateStory(client, parsed, model)
            if (!story) return send(502, { error: 'No story returned' })
            cache.set(parsed.imageUrl, story)
            send(200, { story })
          } catch (err) {
            if (err instanceof AuthenticationError) {
              server.config.logger.error('[story] OpenAI API key was rejected')
              return send(502, { error: 'API key rejected' })
            }
            if (err instanceof RateLimitError) return send(429, { error: 'Rate limited' })
            if (err instanceof APIError) {
              server.config.logger.error(`[story] OpenAI API error ${err.status}: ${err.message}`)
              return send(502, { error: 'Story generation failed' })
            }
            server.config.logger.error(`[story] ${String(err)}`)
            send(500, { error: 'Story generation failed' })
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // '' prefix: read server-side variables too (they are NOT exposed to client code)
  const env = loadEnv(mode, process.cwd(), '')
  const requestedVoice = env.NARRATION_VOICE || process.env.NARRATION_VOICE || DEFAULT_VOICE
  const narrationVoice = isVoice(requestedVoice) ? requestedVoice : DEFAULT_VOICE

  return {
    plugins: [
      react(),
      storyApi(
        env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
        env.OPENAI_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
      ),
    ],
    // The narrator's Kokoro voice runs in the browser; NARRATION_VOICE picks it
    define: {
      __NARRATION_VOICE__: JSON.stringify(narrationVoice),
    },
    // The voice worker imports the model library, so it must be an ES module worker
    worker: {
      format: 'es',
    },
    // Pre-bundle the voice library at startup; otherwise Vite discovers it when the
    // worker first loads and reloads the page, resetting a running timer
    optimizeDeps: {
      include: ['kokoro-js'],
    },
    server: {
      proxy: {
        '/met-api': {
          target: 'https://collectionapi.metmuseum.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/met-api/, ''),
        },
        '/met-images': {
          target: 'https://images.metmuseum.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/met-images/, ''),
        },
      },
    },
  }
})
