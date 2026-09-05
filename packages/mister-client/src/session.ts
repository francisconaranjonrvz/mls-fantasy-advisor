/**
 * Sesiones capturadas de un navegador.
 *
 * El login por email y contrasena no sirve a quien entra en Mister con
 * "Continuar con Google": esa cuenta no tiene contrasena nativa, asi que
 * /api2/auth/email no es una opcion.
 *
 * La alternativa es capturar UNA VEZ la sesion desde un navegador real, donde
 * el OAuth de Google funciona con normalidad, y reutilizar sus cookies. La
 * cookie 'refresh-token' es un JWT cuyo vencimiento esta en el ano 2125, asi
 * que en la practica es permanente mientras el servidor no la revoque.
 *
 * Automatizar el propio OAuth de Google seria mala idea: Google detecta y
 * bloquea navegadores automatizados, y meter ahi las credenciales de una
 * cuenta de Google entera para leer una liga de fantasy es un riesgo
 * desproporcionado. Capturar la sesion una vez evita las dos cosas.
 */

export interface StorageStateCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
}

/** Formato storageState de Playwright, que es lo que exporta el capturador. */
export interface PlaywrightStorageState {
  cookies?: StorageStateCookie[]
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[]
}

/**
 * Sin 'refresh-token' no hay nada que hacer: es la unica credencial de larga
 * duracion. 'token' caduca en unos 5 minutos, asi que casi siempre llega
 * caducada y da igual; el servidor la renueva por Set-Cookie al primer
 * request que lleve un refresh-token valido.
 */
export const ESSENTIAL_COOKIE = 'refresh-token'

/** Cookies que merece la pena conservar; el resto es ruido de analitica y consentimiento. */
export const RELEVANT_COOKIES = ['refresh-token', 'token', 'PHPSESSID']

const isMisterDomain = (domain = ''): boolean =>
  /(^|\.)mundodeportivo\.com$/i.test(domain.replace(/^\./, '')) ||
  /(^|\.)playmister\.com$/i.test(domain.replace(/^\./, ''))

/** Extrae las cookies utiles de un storageState de Playwright. */
export function cookiesFromStorageState(state: PlaywrightStorageState): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of state.cookies ?? []) {
    if (!c?.name || c.value === undefined) continue
    // Si la cookie trae dominio, exigimos que sea de Mister. Si no lo trae
    // (algunos exportadores lo omiten), la aceptamos por nombre.
    if (c.domain && !isMisterDomain(c.domain)) continue
    if (!RELEVANT_COOKIES.includes(c.name)) continue
    out.set(c.name, c.value)
  }
  return out
}

/** Parsea una cabecera Cookie copiada a mano: "a=1; b=2". */
export function parseCookieHeader(header: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    out.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim())
  }
  return out
}

export function toCookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
}

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionFormatError'
  }
}

/**
 * Acepta cualquiera de las formas en que una persona puede pegar su sesion,
 * porque obligar a un formato concreto solo genera errores tontos:
 *   - storageState de Playwright en base64 (lo que produce el capturador)
 *   - ese mismo JSON sin codificar
 *   - una cabecera Cookie copiada de DevTools
 *   - el valor suelto del refresh-token
 */
export function parseSessionInput(raw: string): Map<string, string> {
  const input = raw.trim()
  if (!input) throw new SessionFormatError('La sesion esta vacia')

  // 1. JSON directo o en base64.
  const asJson = tryParseJson(input) ?? tryParseJson(tryDecodeBase64(input))
  if (asJson) {
    const cookies = cookiesFromStorageState(asJson)
    if (cookies.size === 0) {
      throw new SessionFormatError(
        'El JSON de sesion no contiene ninguna cookie de Mister. Comprueba que lo exportaste ' +
          'estando dentro de la liga, no en la pantalla de login.',
      )
    }
    return cookies
  }

  // 2. Cabecera Cookie pegada a mano.
  if (input.includes('=')) {
    const cookies = parseCookieHeader(input)
    const relevant = new Map([...cookies].filter(([k]) => RELEVANT_COOKIES.includes(k)))
    if (relevant.size > 0) return relevant
  }

  // 3. Solo el valor del refresh-token. Se reconoce por la forma de un JWT.
  if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input)) {
    return new Map([[ESSENTIAL_COOKIE, input]])
  }

  throw new SessionFormatError(
    'No se reconoce el formato de la sesion. Se admite: el base64 que imprime el capturador, ' +
      'ese mismo JSON sin codificar, una cabecera Cookie copiada de DevTools, o el valor suelto ' +
      'de refresh-token.',
  )
}

function tryParseJson(text: string | null): PlaywrightStorageState | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? (parsed as PlaywrightStorageState) : null
  } catch {
    return null
  }
}

function tryDecodeBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text) || text.length < 16) return null
  try {
    return Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Un JWT lleva su vencimiento en el payload, asi que se puede avisar de una
 * sesion moribunda ANTES de que empiece a fallar. Solo se decodifica, no se
 * verifica la firma: no tenemos la clave ni nos hace falta.
 */
export function refreshTokenExpiry(cookies: Map<string, string>): Date | null {
  const jwt = cookies.get(ESSENTIAL_COOKIE)
  if (!jwt) return null
  const payload = jwt.split('.')[1]
  if (!payload) return null
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    // Mister emite TODOS los campos del payload como cadena, incluido exp
    // ("4913902471"). Comprobar typeof === 'number' devolvia null con
    // cualquier token real, y el aviso de caducidad no se imprimia jamas.
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp)
    return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null
  } catch {
    return null
  }
}

export interface SessionSummary {
  cookieNames: string[]
  hasRefreshToken: boolean
  expiresAt: Date | null
}

/** Resumen para los logs. Nunca incluye valores de cookie. */
export function describeSession(cookies: Map<string, string>): SessionSummary {
  return {
    cookieNames: [...cookies.keys()],
    hasRefreshToken: cookies.has(ESSENTIAL_COOKIE),
    expiresAt: refreshTokenExpiry(cookies),
  }
}
