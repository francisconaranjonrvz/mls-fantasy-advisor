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
