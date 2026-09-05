/**
 * Transporte HTTP contra mister.mundodeportivo.com.
 *
 * Mister no tiene API publica. Esto replica exactamente las llamadas AJAX que
 * hace su propia web, asi que hay tres cosas que no son opcionales:
 *
 *  1. Un User-Agent de navegador real. Con el UA por defecto de una libreria
 *     las peticiones se rechazan.
 *  2. La cabecera X-Requested-With: XMLHttpRequest, porque el backend
 *     distingue navegacion de AJAX.
 *  3. La cabecera X-Auth, un token por sesion que hay que raspar del HTML.
 *
 * Ademas hay un limite de peticiones no documentado. Todos los scrapers que
 * funcionan se autolimitan; nosotros tambien, con espera aleatoria entre
 * llamadas para no parecer un bucle cerrado.
 */

export const MISTER_BASE = 'https://mister.mundodeportivo.com'

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export interface ThrottleOptions {
  /** Espera minima entre peticiones, en ms. */
  minDelayMs: number
  /** Jitter aleatorio adicional, en ms. */
  jitterMs: number
}

export const POLITE_THROTTLE: ThrottleOptions = { minDelayMs: 5_000, jitterMs: 7_000 }
export const FAST_THROTTLE: ThrottleOptions = { minDelayMs: 400, jitterMs: 400 }

/**
 * Mister no responde 401 a las peticiones de PAGINA cuando la sesion ha
 * muerto: responde 302 hacia /new-onboarding/ con el cuerpo vacio. Como el
 * cliente usa redirect:'manual', eso llegaba como un 302 generico y se
 * convertia en un MisterHttpError incomprensible.
 *
 * Detectarlo en el transporte lo arregla de una vez para las cuatro rutas.
 */
export class MisterSessionExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MisterSessionExpiredError'
  }
}

/** Destino del redirect con el que Mister expulsa a quien no tiene sesion. */
const AUTH_REDIRECT_MARKER = 'new-onboarding'

export class MisterHttpError extends Error {
  readonly status: number
  readonly path: string
  readonly body: string

  constructor(status: number, path: string, body: string) {
    super(`Mister respondio ${status} en ${path}: ${body.slice(0, 200)}`)
    this.name = 'MisterHttpError'
    this.status = status
    this.path = path
    this.body = body
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Reconoce una cookie de borrado. Mister expulsa una sesion muerta enviando
 * 'token=0; Max-Age=0' y 'refresh-token=0; Max-Age=0'; guardar eso como si
 * fuera un valor nuevo dejaba el tarro inservible.
 */
function isDeletionCookie(attributes: string[], value: string): boolean {
  if (value === '' || value === '0') return true
  for (const attr of attributes.slice(1)) {
    const [rawKey, ...rest] = attr.split('=')
    const key = (rawKey ?? '').trim().toLowerCase()
    const val = rest.join('=').trim()
    if (key === 'max-age' && Number(val) <= 0) return true
    if (key === 'expires') {
      const when = Date.parse(val)
      if (Number.isFinite(when) && when <= Date.now()) return true
    }
  }
  return false
}

/**
 * Cliente HTTP con cookies propias y autolimitacion.
 *
 * fetch() no tiene tarro de cookies, pero solo necesitamos dos (`token` y
 * `refresh-token`), asi que las gestionamos a mano.
 */
export class MisterHttp {
  private cookies = new Map<string, string>()
  private lastRequestAt = 0
  xAuth: string | undefined
  leagueId: string | undefined

  private readonly throttle: ThrottleOptions

  constructor(throttle: ThrottleOptions = POLITE_THROTTLE) {
    this.throttle = throttle
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  /** Restaura una sesion previa sin volver a hacer login. */
  loadSession(session: { cookies: string; xAuth: string; leagueId?: string | undefined }): void {
    for (const part of session.cookies.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k && rest.length) this.cookies.set(k, rest.join('='))
    }
    this.xAuth = session.xAuth
    this.leagueId = session.leagueId
  }

  /**
   * Absorbe las cookies nuevas, que es como se renueva el token de 5 minutos.
   *
   * Ojo con las cookies de BORRADO: al expulsar una sesion, Mister responde con
   * 'token=0; Max-Age=0' y 'refresh-token=0; Max-Age=0'. Guardarlas tal cual
   * envenenaba el tarro y dejaba la sesion inservible para el resto del
   * proceso, aunque las cookies originales fueran buenas. Se descartan por
   * Max-Age, por expires pasado y por el valor centinela.
   */
  private absorbSetCookie(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const parts = raw.split(';')
      const pair = parts[0]
      if (!pair) continue
      const idx = pair.indexOf('=')
      if (idx <= 0) continue

      const name = pair.slice(0, idx).trim()
      const value = pair.slice(idx + 1).trim()
      if (!['token', 'refresh-token', 'PHPSESSID'].includes(name)) continue

      if (isDeletionCookie(parts, value)) {
        this.cookies.delete(name)
        continue
      }
      this.cookies.set(name, value)
    }
  }

  /**
   * Lanza si la respuesta es el redirect con el que Mister expulsa a las
   * sesiones muertas. Se comprueba antes que res.ok porque un 302 no es ok y
   * si no acabaria camuflado como un error de transporte cualquiera.
   */
  private assertNotExpired(res: Response, path: string): void {
    if (res.status < 300 || res.status >= 400) return
    const location = res.headers.get('location') ?? ''
    if (location.includes(AUTH_REDIRECT_MARKER)) {
      throw new MisterSessionExpiredError(
        `Mister redirigio ${path} a la pantalla de acceso: la sesion ya no es valida.`,
      )
    }
  }

  private async waitTurn(): Promise<void> {
    const wait =
      this.lastRequestAt + this.throttle.minDelayMs + Math.random() * this.throttle.jitterMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastRequestAt = Date.now()
  }

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'es-ES,es;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: MISTER_BASE,
      Referer: `${MISTER_BASE}/feed`,
      ...extra,
    }
    const cookie = this.cookieHeader
    if (cookie) h['Cookie'] = cookie
    if (this.xAuth) h['X-Auth'] = this.xAuth
    if (this.leagueId) h['x-league'] = this.leagueId
    return h
  }

  /** POST con cuerpo JSON. Lo usan los endpoints /api2/. */
  async postJson<T>(path: string, body: unknown): Promise<{ data: T; res: Response }> {
    await this.waitTurn()
    const res = await fetch(`${MISTER_BASE}${path}`, {
      method: 'POST',
      headers: this.baseHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify(body),
      redirect: 'manual',
    })
    this.absorbSetCookie(res)
    this.assertNotExpired(res, path)
    const text = await res.text()
    if (!res.ok) throw new MisterHttpError(res.status, path, text)
    return { data: text ? (JSON.parse(text) as T) : (undefined as T), res }
  }

  /** POST form-encoded que devuelve JSON. Lo usan los endpoints /ajax/. */
  async postForm<T>(path: string, form: Record<string, string | number>): Promise<T> {
    await this.waitTurn()
    const body = new URLSearchParams(
      Object.entries(form).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString()
    const res = await fetch(`${MISTER_BASE}${path}`, {
      method: 'POST',
      headers: this.baseHeaders({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      }),
      body,
      redirect: 'manual',
    })
    this.absorbSetCookie(res)
    this.assertNotExpired(res, path)
    const text = await res.text()
    if (!res.ok) throw new MisterHttpError(res.status, path, text)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new MisterHttpError(res.status, path, `respuesta no era JSON: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Trae una pagina como fragmento HTML parcial.
   * Mister devuelve el fragmento (en vez de la pagina entera) cuando se pide
   * por POST con cuerpo vacio, que es como navega su propia SPA.
   */
  async fetchPartial(path: string): Promise<string> {
    await this.waitTurn()
    const res = await fetch(`${MISTER_BASE}${path}`, {
      method: 'POST',
      headers: this.baseHeaders({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'partial-request': 'true',
      }),
      body: '',
      redirect: 'manual',
    })
    this.absorbSetCookie(res)
    this.assertNotExpired(res, path)
    const text = await res.text()
    if (!res.ok) throw new MisterHttpError(res.status, path, text)
    return text
  }

  /** GET de una pagina completa. Necesario para raspar el token X-Auth. */
  async fetchPage(path: string): Promise<string> {
    await this.waitTurn()
    const res = await fetch(`${MISTER_BASE}${path}`, {
      method: 'GET',
      headers: this.baseHeaders({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }),
      redirect: 'manual',
    })
    this.absorbSetCookie(res)
    this.assertNotExpired(res, path)
    const text = await res.text()
    if (!res.ok) throw new MisterHttpError(res.status, path, text)
    return text
  }
}
