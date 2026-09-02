/**
 * Capa de proveedores de IA.
 *
 * Existe por una razon concreta: el nivel gratuito de build.nvidia.com
 * funciona por creditos y se puede agotar. Cuando eso pase no queremos
 * reescribir la aplicacion, sino cambiar una variable de entorno. Por eso
 * todo pasa por una interfaz minima y hay un segundo proveedor listo.
 *
 * Los modelos estan elegidos probandolos, no por catalogo. Se les planteo una
 * tarea numerica real de la liga (calcular la puja maxima con el margen de
 * deuda del 25% y decidir que clausula es pagable) y se comparo exactitud,
 * calidad del español y latencia. Ademas, varios modelos que aparecen en la
 * documentacion de NVIDIA ya estan retirados y devuelven 410: no sirve
 * fiarse de las listas, hay que llamarlos.
 */

export type ProviderName = 'nvidia' | 'workers-ai'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

export interface LlmProvider {
  readonly name: ProviderName
  readonly model: string
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
}

/** Verificado el 2026-09-02 contra integrate.api.nvidia.com. */
export const NVIDIA_MODELS = {
  /** Calculo correcto, español limpio, ~4s. */
  primary: 'nvidia/nemotron-3-super-120b-a12b',
  /** Apache-2.0 y el mas rapido, pero tiende a soltar LaTeX en la respuesta. */
  fallback: 'openai/gpt-oss-120b',
  /** Mas capaz y con llamada a herramientas, pero ~11s: solo para analisis pesado. */
  heavy: 'nvidia/nemotron-3-ultra-550b-a55b',
} as const

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

export class NvidiaProvider implements LlmProvider {
  readonly name = 'nvidia' as const
  readonly model: string

  constructor(private readonly apiKey: string, model: string = NVIDIA_MODELS.primary) {
    this.model = model
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const res = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1400,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new LlmError(`NVIDIA respondio ${res.status}`, res.status, body.slice(0, 300))
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return stripReasoning(data.choices?.[0]?.message?.content ?? '')
  }
}

/**
 * Respaldo dentro de la propia Cloudflare: 10.000 neuronas al dia gratis y sin
 * proveedores nuevos. Es peor modelo, pero mantiene el chat vivo si NVIDIA se
 * queda sin creditos.
 */
export class WorkersAiProvider implements LlmProvider {
  readonly name = 'workers-ai' as const
  readonly model = '@cf/meta/llama-3.1-8b-instruct-fast'

  constructor(private readonly ai: { run: (model: string, input: unknown) => Promise<unknown> }) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const out = (await this.ai.run(this.model, {
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1200,
    })) as { response?: string }
    return stripReasoning(out.response ?? '')
  }
}

export class LlmError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.detail = detail
  }
}

/**
 * Los modelos de razonamiento emiten su cadena de pensamiento entre etiquetas
 * <think>. Es util para depurar y ruido para el usuario, asi que se recorta.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim()
}

export interface ProviderEnv {
  AI_PROVIDER?: string
  NVIDIA_API_KEY?: string
  NVIDIA_MODEL?: string
  AI?: { run: (model: string, input: unknown) => Promise<unknown> }
}

/** Construye la cadena de proveedores: el preferido primero y el respaldo detras. */
export function buildProviders(env: ProviderEnv): LlmProvider[] {
  const chain: LlmProvider[] = []
  const preferred = (env.AI_PROVIDER ?? 'nvidia') as ProviderName

  if (env.NVIDIA_API_KEY) {
    chain.push(new NvidiaProvider(env.NVIDIA_API_KEY, env.NVIDIA_MODEL || NVIDIA_MODELS.primary))
  }
  if (env.AI) {
    chain.push(new WorkersAiProvider(env.AI))
  }
  if (preferred === 'workers-ai') chain.reverse()

  return chain
}

/** Prueba los proveedores en orden hasta que uno responda. */
export async function chatWithFallback(
  providers: LlmProvider[],
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<{ text: string; provider: string; model: string }> {
  if (providers.length === 0) {
    throw new LlmError('No hay ningun proveedor de IA configurado', 500, 'falta NVIDIA_API_KEY o el binding AI')
  }

  let last: unknown
  for (const p of providers) {
    try {
      const text = await p.chat(messages, opts)
      if (text) return { text, provider: p.name, model: p.model }
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('Todos los proveedores de IA fallaron')
}
