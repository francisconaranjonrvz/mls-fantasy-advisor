import { describe, it, expect } from 'vitest'
import {
  parseSessionInput, parseCookieHeader, cookiesFromStorageState, toCookieHeader,
  refreshTokenExpiry, describeSession, SessionFormatError, ESSENTIAL_COOKIE,
} from './session.ts'

/** JWT con la forma real pero inofensivo: payload {"exp":4890499200}, que cae en 2124. */
const FAKE_JWT =
  'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjQ4OTA0OTkyMDAsInVzZXJpZCI6MTIzNH0.ZmFrZXNpZ25hdHVyZQ'

const STORAGE_STATE = {
  cookies: [
    { name: 'refresh-token', value: FAKE_JWT, domain: '.mundodeportivo.com', path: '/' },
    { name: 'token', value: 'corto', domain: 'mister.mundodeportivo.com', path: '/' },
    { name: 'PHPSESSID', value: 'abc123', domain: 'mister.mundodeportivo.com', path: '/' },
    { name: '_ga', value: 'analitica', domain: '.mundodeportivo.com', path: '/' },
    { name: 'otra', value: 'x', domain: '.google.com', path: '/' },
  ],
  origins: [],
}

describe('cookiesFromStorageState', () => {
  const cookies = cookiesFromStorageState(STORAGE_STATE)

  it('conserva solo las cookies que Mister necesita', () => {
    expect([...cookies.keys()].sort()).toEqual(['PHPSESSID', 'refresh-token', 'token'])
  })

  it('descarta analitica y cookies de otros dominios', () => {
    expect(cookies.has('_ga')).toBe(false)
    expect(cookies.has('otra')).toBe(false)
  })
})

describe('parseSessionInput acepta las formas en que una persona puede pegar la sesion', () => {
  it('base64 del storageState, que es lo que imprime el capturador', () => {
    const b64 = Buffer.from(JSON.stringify(STORAGE_STATE), 'utf8').toString('base64')
    expect(parseSessionInput(b64).get(ESSENTIAL_COOKIE)).toBe(FAKE_JWT)
  })

  it('el mismo JSON sin codificar', () => {
    expect(parseSessionInput(JSON.stringify(STORAGE_STATE)).get(ESSENTIAL_COOKIE)).toBe(FAKE_JWT)
  })

  it('una cabecera Cookie copiada de DevTools', () => {
    const header = `_ga=basura; refresh-token=${FAKE_JWT}; token=corto`
    const cookies = parseSessionInput(header)
    expect(cookies.get(ESSENTIAL_COOKIE)).toBe(FAKE_JWT)
    expect(cookies.has('_ga')).toBe(false)
  })

  it('el valor suelto del refresh-token', () => {
    expect(parseSessionInput(FAKE_JWT).get(ESSENTIAL_COOKIE)).toBe(FAKE_JWT)
  })

  it('tolera espacios y saltos de linea alrededor', () => {
    const b64 = Buffer.from(JSON.stringify(STORAGE_STATE), 'utf8').toString('base64')
    expect(parseSessionInput(`\n  ${b64}  \n`).get(ESSENTIAL_COOKIE)).toBe(FAKE_JWT)
  })
})

describe('parseSessionInput falla de forma util', () => {
  it('rechaza una sesion vacia', () => {
    expect(() => parseSessionInput('   ')).toThrow(SessionFormatError)
  })

  it('rechaza un formato irreconocible', () => {
    expect(() => parseSessionInput('esto no es una sesion')).toThrow(SessionFormatError)
  })

  it('avisa cuando el JSON no trae cookies de Mister, que es el error tipico de capturar sin loguear', () => {
    const vacio = JSON.stringify({ cookies: [{ name: '_ga', value: 'x', domain: '.google.com' }] })
    expect(() => parseSessionInput(vacio)).toThrow(/no contiene ninguna cookie de Mister/)
  })
})

describe('vencimiento del refresh-token', () => {
  it('lee el exp del JWT sin verificar la firma', () => {
    const cookies = new Map([[ESSENTIAL_COOKIE, FAKE_JWT]])
    const exp = refreshTokenExpiry(cookies)
    expect(exp).toBeInstanceOf(Date)
    expect(exp!.getUTCFullYear()).toBe(2124)
  })

  it('confirma lo que importa: el refresh-token es practicamente permanente', () => {
    // Mister emite refresh-tokens con vencimiento a mas de un siglo vista, asi
    // que la sesion no muere por caducidad del JWT sino por revocacion.
    const exp = refreshTokenExpiry(new Map([[ESSENTIAL_COOKIE, FAKE_JWT]]))!
    expect(exp.getUTCFullYear()).toBeGreaterThan(2100)
  })

  it('devuelve null si no hay refresh-token', () => {
    expect(refreshTokenExpiry(new Map([['token', 'x']]))).toBeNull()
  })

  it('devuelve null ante un JWT ilegible en vez de reventar', () => {
    expect(refreshTokenExpiry(new Map([[ESSENTIAL_COOKIE, 'no.es.jwt']]))).toBeNull()
  })
})

describe('describeSession', () => {
  it('resume sin exponer ningun valor de cookie', () => {
    const cookies = parseSessionInput(JSON.stringify(STORAGE_STATE))
    const s = describeSession(cookies)
    expect(s.hasRefreshToken).toBe(true)
    expect(s.cookieNames).toContain('refresh-token')
    expect(JSON.stringify(s)).not.toContain(FAKE_JWT)
  })
})

describe('utilidades de cookies', () => {
  it('ida y vuelta entre cabecera y mapa', () => {
    const header = 'a=1; b=2'
    expect(toCookieHeader(parseCookieHeader(header))).toBe(header)
  })

  it('ignora fragmentos malformados en vez de romper', () => {
    expect([...parseCookieHeader('a=1; ; =sinclave; b=2').keys()]).toEqual(['a', 'b'])
  })
})
