import { describe, it, expect, vi, afterEach } from 'vitest'
import { MisterHttp, MisterSessionExpiredError, MisterHttpError, FAST_THROTTLE } from './http.ts'

/**
 * Regresiones de dos fallos reales, comprobados contra produccion el 2026-09-05.
 *
 * Ante una sesion muerta, Mister NO responde 401 a las peticiones de pagina.
 * Responde 302 hacia /new-onboarding/ con el cuerpo vacio y, de paso, envia
 * cookies de borrado con Max-Age=0 para cargarse la sesion del cliente.
 */

function mockFetch(responses: Response[]): void {
  const queue = [...responses]
  vi.stubGlobal('fetch', vi.fn(async () => queue.shift() ?? new Response('', { status: 500 })))
}

/** Reproduce la respuesta literal de Mister ante una sesion muerta. */
function expiredRedirect(): Response {
  const headers = new Headers({ location: 'https://mister.mundodeportivo.com/new-onboarding/' })
  headers.append('set-cookie', 'PHPSESSID=nuevo123; path=/')
  headers.append('set-cookie', 'login=0; expires=Sat, 05 Sep 2026 07:51:58 GMT; Max-Age=0; path=/')
  headers.append('set-cookie', 'token=0; expires=Sat, 05 Sep 2026 07:51:58 GMT; Max-Age=0; path=/')
  headers.append('set-cookie', 'refresh-token=0; expires=Sat, 05 Sep 2026 07:51:58 GMT; Max-Age=0; path=/')
  return new Response('', { status: 302, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('sesion caducada: el 302 a /new-onboarding/', () => {
  it('se reconoce como sesion caducada y no como error de transporte', async () => {
    mockFetch([expiredRedirect()])
    const http = new MisterHttp(FAST_THROTTLE)
    await expect(http.fetchPage('/market')).rejects.toBeInstanceOf(MisterSessionExpiredError)
  })

  it('tambien en las peticiones AJAX, no solo en las de pagina', async () => {
    mockFetch([expiredRedirect(), expiredRedirect(), expiredRedirect()])
    const http = new MisterHttp(FAST_THROTTLE)
    await expect(http.postForm('/ajax/balance', {})).rejects.toBeInstanceOf(MisterSessionExpiredError)
    await expect(http.fetchPartial('/team')).rejects.toBeInstanceOf(MisterSessionExpiredError)
    await expect(http.postJson('/api2/x', {})).rejects.toBeInstanceOf(MisterSessionExpiredError)
  })

  it('un redirect que NO sea de expulsion sigue siendo un error de transporte normal', async () => {
    mockFetch([new Response('', { status: 302, headers: { location: '/otra-pagina' } })])
    const http = new MisterHttp(FAST_THROTTLE)
    await expect(http.fetchPage('/market')).rejects.toBeInstanceOf(MisterHttpError)
  })
})

describe('las cookies de borrado no deben envenenar el tarro', () => {
  it('una sesion expulsada no sobreescribe el refresh-token bueno con un 0', async () => {
    mockFetch([expiredRedirect()])
    const http = new MisterHttp(FAST_THROTTLE)
    http.setCookie('refresh-token', 'jwt-bueno')
    http.setCookie('token', 'corto')

    await expect(http.fetchPage('/market')).rejects.toBeInstanceOf(MisterSessionExpiredError)

    // Lo que importa: en ningun caso puede quedar guardado el valor centinela.
    expect(http.cookieHeader).not.toContain('refresh-token=0')
    expect(http.cookieHeader).not.toContain('token=0')
  })

  it('si la respuesta trae cookies validas, si se absorben (asi se renueva el token corto)', async () => {
    const headers = new Headers()
    headers.append('set-cookie', 'token=renovado; path=/; HttpOnly')
    mockFetch([new Response('<html>ok</html>', { status: 200, headers })])

    const http = new MisterHttp(FAST_THROTTLE)
    http.setCookie('refresh-token', 'jwt-bueno')
    await http.fetchPage('/market')

    expect(http.cookieHeader).toContain('token=renovado')
    expect(http.cookieHeader).toContain('refresh-token=jwt-bueno')
  })

  it('descarta una cookie con expires en el pasado aunque no traiga Max-Age', async () => {
    const headers = new Headers()
    headers.append('set-cookie', 'token=basura; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/')
    mockFetch([new Response('<html>ok</html>', { status: 200, headers })])

    const http = new MisterHttp(FAST_THROTTLE)
    await http.fetchPage('/market')
    expect(http.cookieHeader).not.toContain('token=basura')
  })
})

describe('recuperacion de un X-Auth rancio a mitad de ingesta', () => {
  const ok = () => new Response(JSON.stringify({ status: 'ok', data: { balance: 10 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  /** Respuesta literal de Mister ante un 401 en /ajax/*: 32 bytes, opaca. */
  const unauthorized = () => new Response('{"status":"error","popup":false}', { status: 401 })

  it('renueva el token y reintenta una vez en lugar de tirar la ingesta', async () => {
    mockFetch([unauthorized(), ok()])
    const http = new MisterHttp(FAST_THROTTLE)
    http.xAuth = 'rancio'
    http.onStaleAuth = async () => 'fresco'

    const res = await http.postForm<{ status: string }>('/ajax/balance', {})
    expect(res.status).toBe('ok')
    expect(http.xAuth).toBe('fresco')
  })

  it('si tampoco se puede renovar, lo trata como sesion caducada y no como 401 opaco', async () => {
    mockFetch([unauthorized()])
    const http = new MisterHttp(FAST_THROTTLE)
    http.onStaleAuth = async () => null

    await expect(http.postForm('/ajax/balance', {})).rejects.toBeInstanceOf(MisterSessionExpiredError)
  })

  it('no reintenta en bucle: si el segundo intento tambien falla, propaga', async () => {
    mockFetch([unauthorized(), unauthorized()])
    const http = new MisterHttp(FAST_THROTTLE)
    let renovaciones = 0
    http.onStaleAuth = async () => { renovaciones++; return 'fresco' }

    await expect(http.postForm('/ajax/balance', {})).rejects.toBeInstanceOf(MisterHttpError)
    expect(renovaciones).toBe(1)
  })

  it('sin hook instalado, un 401 sigue siendo un error de transporte normal', async () => {
    mockFetch([unauthorized()])
    const http = new MisterHttp(FAST_THROTTLE)
    await expect(http.postForm('/ajax/balance', {})).rejects.toBeInstanceOf(MisterHttpError)
  })
})
