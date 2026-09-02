import { buildProviders, chatWithFallback, LlmError, type ChatMessage, type ProviderEnv } from './providers.ts'
import { loadLeagueData, buildSystemPrompt, type WorkerEnv } from './context.ts'

/**
 * Un unico Worker sirve el dashboard y expone la API.
 *
 * Los ficheros estaticos van por el binding ASSETS, que en Cloudflare no
 * consume la cuota de peticiones: solo cuentan las que ejecutan codigo. En
 * la practica solo /api/chat gasta cuota, y para un uso personal eso es
 * inalcanzable.
 *
 * La clave de NVIDIA vive como secreto del Worker y nunca llega al navegador,
 * que es la razon por la que el chat no puede vivir en una web estatica pura
 * como GitHub Pages: cualquier clave que se envie al cliente es publica.
 */

interface Env extends ProviderEnv, WorkerEnv {
  ASSETS?: { fetch: (req: Request) => Promise<Response> }
  ALLOWED_ORIGIN?: string
}

const MAX_MESSAGE_CHARS = 4_000
const MAX_HISTORY = 12

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        providers: buildProviders(env).map((p) => ({ name: p.name, model: p.model })),
      })
    }

    if (url.pathname === '/api/state') {
      try {
        const data = await loadLeagueData(env)
        return json(data.diagnosis)
      } catch (err) {
        return json({ error: String(err) }, 502)
      }
    }

    if (url.pathname === '/api/chat') {
      return handleChat(request, env)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'No existe ese endpoint' }, 404)
    }

    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response('Dashboard no desplegado todavia', { status: 404 })
  },
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Usa POST' }, 405)
  }

  // Este endpoint gasta creditos de IA, asi que solo se atiende desde la
  // propia pagina. Sin esto, cualquiera con la URL podria agotar la cuota.
  const origin = request.headers.get('Origin')
  const allowed = env.ALLOWED_ORIGIN
  if (allowed && origin && origin !== allowed) {
    return json({ error: 'Origen no permitido' }, 403)
  }

  let body: { message?: unknown; history?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'El cuerpo debe ser JSON' }, 400)
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return json({ error: 'Falta el campo message' }, 400)
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: `El mensaje excede ${MAX_MESSAGE_CHARS} caracteres` }, 413)
  }

  const history: ChatMessage[] = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter((m): m is ChatMessage =>
          typeof m === 'object' && m !== null &&
          (m as ChatMessage).role !== 'system' &&
          typeof (m as ChatMessage).content === 'string',
        )
        .slice(-MAX_HISTORY)
    : []

  let systemPrompt: string
  try {
    systemPrompt = buildSystemPrompt(await loadLeagueData(env))
  } catch (err) {
    return json(
      {
        error:
          'No se pudieron cargar los datos de la liga. Si la ingesta no ha corrido nunca, ' +
          'lanza el workflow "Ingesta diaria" primero.',
        detail: String(err),
      },
      503,
    )
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ]

  try {
    const result = await chatWithFallback(buildProviders(env), messages)
    return json(result)
  } catch (err) {
    if (err instanceof LlmError) {
      return json({ error: err.message, detail: err.detail }, 502)
    }
    return json({ error: 'Fallo la llamada al modelo', detail: String(err) }, 502)
  }
}
