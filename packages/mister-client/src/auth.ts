import { MisterHttp, MisterHttpError } from './http.ts'

/**
 * Login en Mister.
 *
 * Son tres pasos, y hacen falta los tres:
 *
 *  1. POST /api2/auth/email con email y password devuelve un JWT de vida corta
 *     (unos 5 minutos).
 *  2. POST /api2/auth/external/exchange-token canjea ese JWT por dos cookies:
 *     `token` (corta) y `refresh-token` (caduca en 2125, es decir, permanente).
 *  3. El backend exige ademas una cabecera X-Auth que NO viene en ninguna
 *     respuesta de la API: va incrustada en el HTML de las paginas, dentro de
 *     un <script> inline con la forma "auth":"<hex>". Hay que raspar una
 *     pagina autenticada para obtenerla.
 *
 * El paso 3 es el fragil: si Mister mueve ese token a un bundle JS externo,
 * este metodo deja de funcionar y haria falta un navegador headless. Por eso
 * el error correspondiente es explicito.
 */

export interface MisterCredentials {
  email: string
  password: string
}

export interface MisterSession {
  /** Cabecera Cookie serializada, lista para reutilizar. */
  cookies: string
  /** Token de la cabecera X-Auth. */
  xAuth: string
  leagueId?: string | undefined
}

export class MisterAuthError extends Error {
  readonly detail: unknown

  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'MisterAuthError'
    this.detail = detail
  }
}

const X_AUTH_PATTERN = /"auth"\s*:\s*"([a-zA-Z0-9]+)"/

/** Extrae el token X-Auth del HTML de una pagina autenticada. */
export function extractXAuth(html: string): string | null {
  return X_AUTH_PATTERN.exec(html)?.[1] ?? null
}

/**
 * Extrae el id de liga del HTML. Mister lo expone como x-league / id_competition.
 * Permite no tener que configurarlo a mano.
 */
export function extractLeagueId(html: string): string | null {
  for (const re of [
    /"id_competition"\s*:\s*"?(\d+)"?/,
    /data-id_competition=["'](\d+)["']/,
    /"community"\s*:\s*\{[^}]*"id"\s*:\s*"?(\d+)"?/,
  ]) {
    const m = re.exec(html)
    if (m?.[1]) return m[1]
  }
  return null
}

export async function login(
  creds: MisterCredentials,
  http: MisterHttp = new MisterHttp(),
): Promise<{ http: MisterHttp; session: MisterSession }> {
  if (!creds.email || !creds.password) {
    throw new MisterAuthError(
      'Faltan MISTER_EMAIL o MISTER_PASSWORD. En local van en .env; en CI, como secrets del repositorio.',
    )
  }

  // Paso 1: credenciales -> JWT de vida corta.
  let token: string
  try {
    const { data } = await http.postJson<{ token?: string }>('/api2/auth/email', {
      email: creds.email,
      password: creds.password,
    })
    if (!data?.token) throw new MisterAuthError('El login no devolvio token')
    token = data.token
  } catch (err) {
    if (err instanceof MisterHttpError && err.status === 401) {
      throw new MisterAuthError('Credenciales de Mister rechazadas (401)', err)
    }
    throw err instanceof MisterAuthError ? err : new MisterAuthError('Fallo el login', err)
  }

  // Paso 2: canjear el JWT por cookies de sesion.
  await http.postJson('/api2/auth/external/exchange-token', { token })
  if (!http.cookieHeader.includes('token=')) {
    throw new MisterAuthError('El canje de token no devolvio cookies de sesion')
  }

  // Paso 3: raspar X-Auth de una pagina autenticada.
  const html = await http.fetchPage('/market')
  const xAuth = extractXAuth(html)
  if (!xAuth) {
    throw new MisterAuthError(
      'No se encontro el token X-Auth en el HTML de /market. Es probable que Mister lo haya ' +
        'movido fuera del <script> inline; habria que revisar extractXAuth o usar un navegador headless.',
    )
  }
  http.xAuth = xAuth

  const leagueId = extractLeagueId(html) ?? undefined
  if (leagueId) http.leagueId = leagueId

  return { http, session: { cookies: http.cookieHeader, xAuth, leagueId } }
}
