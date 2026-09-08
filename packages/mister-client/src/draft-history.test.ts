import { describe, it, expect } from 'vitest'
import type { PlayerDetail } from './endpoints.ts'
import {
  parseSpanishDate, ownerChain, draftOwner, valueOn, reconstructDraft,
} from './draft-history.ts'

/**
 * Las fichas de este fichero estan copiadas de respuestas reales de
 * /ajax/sw/players, con los nombres cambiados. Importa que sean reales: el
 * tipo que yo habia escrito para values_chart era `{x, y}` y el campo de
 * verdad es `{value, date}`. Contra un fixture inventado por mi, ese error
 * habria seguido invisible porque lo habria inventado igual de mal.
 */

const REPARTIDO_Y_CONSERVADO: PlayerDetail = {
  // Mathew Ryan: es mio, nunca lo compre, y su cadena viene VACIA.
  owners: [],
  values_chart: {
    points: [
      { value: 9_084_000, date: '17 ago 2026' },
      { value: 9_400_000, date: '1 sept 2026' },
      { value: 9_901_000, date: '8 sept 2026' },
    ],
  },
}

const REPARTIDO_Y_VENDIDO: PlayerDetail = {
  // Su cadena empieza saliendo de mi, asi que era mio en el reparto.
  owners: [
    { id: 543_600_000, id_uc_from: 15531409, id_uc_to: 0, from: 'Cuggito', to: 'Mister',
      price: 1_500_000, date: '23 ago 2026', type: 'normal' },
  ],
  values_chart: { points: [{ value: 1_373_000, date: '17 ago 2026' }] },
}

const COMPRADO_AL_MERCADO: PlayerDetail = {
  // Sale de Mister, o sea que al empezar no era de nadie.
  owners: [
    { id: 543_645_478, id_uc_from: 0, id_uc_to: 15531722, from: 'Mister', to: 'Paquete fc',
      price: 16_869_787, date: '31 ago 2026', type: 'normal' },
  ],
  values_chart: { points: [{ value: 16_801_000, date: '17 ago 2026' }] },
}

const CON_VARIOS_DUENNOS: PlayerDetail = {
  // Aubameyang: dos clausulazos. El primero sale de Paquete fc, que por tanto
  // lo tenia del reparto aunque hoy sea mio.
  owners: [
    { id: 543_700_000, id_uc_from: 15531722, id_uc_to: 15531394, from: 'Paquete fc',
      to: 'Rxul_2504', price: 5_604_000, date: '24 ago 2026', type: 'clause' },
    { id: 543_900_000, id_uc_from: 15531394, id_uc_to: 15531409, from: 'Rxul_2504',
      to: 'Cuggito', price: 8_815_500, date: '5 sept 2026', type: 'clause' },
  ],
  values_chart: { points: [{ value: 5_200_000, date: '17 ago 2026' }] },
}

describe('fechas en castellano abreviado', () => {
  it('entiende el formato de Mister', () => {
    expect(parseSpanishDate('17 ago 2026')).toBe('2026-08-17')
    expect(parseSpanishDate('1 ene 2026')).toBe('2026-01-01')
    expect(parseSpanishDate('31 dic 2025')).toBe('2025-12-31')
  })

  it('aguanta que septiembre venga con cuatro letras', () => {
    // Los demas meses vienen con tres y septiembre con "sept". Si esto se
    // trata como mes desconocido se pierde un mes entero de la serie.
    expect(parseSpanishDate('8 sept 2026')).toBe('2026-09-08')
    expect(parseSpanishDate('8 sep 2026')).toBe('2026-09-08')
  })

  it('devuelve null en vez de una fecha inventada', () => {
    expect(parseSpanishDate('ayer')).toBeNull()
    expect(parseSpanishDate('17 xxx 2026')).toBeNull()
    expect(parseSpanishDate(undefined)).toBeNull()
  })

  it('ordena como texto, que es para lo que se usa', () => {
    expect(parseSpanishDate('9 sept 2026')! > parseSpanishDate('17 ago 2026')!).toBe(true)
  })
})

describe('a quien le toco cada jugador en el reparto', () => {
  it('cadena vacia significa que sigue en la plantilla que se lo llevo', () => {
    // Este es el hallazgo del que cuelga todo lo demas. El reparto no genera
    // registro de traspaso, asi que la AUSENCIA de cadena es el dato.
    expect(draftOwner(REPARTIDO_Y_CONSERVADO, 15531409)).toBe(15531409)
  })

  it('un jugador sin duenno y sin cadena no fue repartido a nadie', () => {
    expect(draftOwner(REPARTIDO_Y_CONSERVADO, 0)).toBe(0)
  })

  it('si lo vendio, el duenno del reparto es de quien sale la primera entrada', () => {
    expect(draftOwner(REPARTIDO_Y_VENDIDO, 0)).toBe(15531409)
  })

  it('si la primera entrada sale de Mister, al empezar era libre', () => {
    // Aunque hoy lo tenga alguien: lo compro despues, no se lo repartieron.
    expect(draftOwner(COMPRADO_AL_MERCADO, 15531722)).toBe(0)
  })

  it('con varios duennos manda el primero de la cadena, no el actual', () => {
    expect(draftOwner(CON_VARIOS_DUENNOS, 15531409)).toBe(15531722)
  })

  it('ordena la cadena por id de traspaso, no por como venga', () => {
    const desordenado: PlayerDetail = {
      ...CON_VARIOS_DUENNOS,
      owners: [...CON_VARIOS_DUENNOS.owners!].reverse(),
    }
    expect(ownerChain(desordenado)[0]!.from).toBe('Paquete fc')
    expect(draftOwner(desordenado, 15531409)).toBe(15531722)
  })
})

describe('valor en la fecha del reparto', () => {
  it('coge el del dia exacto cuando esta', () => {
    expect(valueOn(REPARTIDO_Y_CONSERVADO, '2026-08-17')).toBe(9_084_000)
  })

  it('no usa el de hoy, que es la fuente de error que esto viene a quitar', () => {
    // Ryan valia 9.084.000 el dia del reparto y 9.901.000 tres semanas
    // despues. Esos 817.000 iban enteros contra la caja inicial estimada.
    expect(valueOn(REPARTIDO_Y_CONSERVADO, '2026-08-17'))
      .not.toBe(valueOn(REPARTIDO_Y_CONSERVADO, '2026-09-08'))
  })

  it('si falta el dia exacto arrastra el ultimo anterior', () => {
    // El valor solo cambia cuando Mister revaloriza, asi que el previo es el
    // valor correcto de ese dia, no una aproximacion.
    expect(valueOn(REPARTIDO_Y_CONSERVADO, '2026-08-20')).toBe(9_084_000)
  })

  it('devuelve null si la serie no llega, que no es lo mismo que valer cero', () => {
    expect(valueOn(REPARTIDO_Y_CONSERVADO, '2026-01-01')).toBeNull()
    expect(valueOn({}, '2026-08-17')).toBeNull()
  })
})

describe('reconstruccion del reparto de toda la liga', () => {
  const detalles = new Map<number, PlayerDetail>([
    [28612, REPARTIDO_Y_CONSERVADO],
    [4753, REPARTIDO_Y_VENDIDO],
    [55009, COMPRADO_AL_MERCADO],
    [36410, CON_VARIOS_DUENNOS],
  ])
  const duennos = new Map<number, number>([
    [28612, 15531409], [4753, 0], [55009, 15531722], [36410, 15531409],
  ])

  it('suma por manager al valor del dia del reparto', () => {
    const r = reconstructDraft(detalles, duennos, '2026-08-17')
    // Mios: Ryan (conservado) y el vendido.
    expect(r.valueByManager['15531409']).toBe(9_084_000 + 1_373_000)
    // De Paquete fc solo Aubameyang: al otro lo compro despues.
    expect(r.valueByManager['15531722']).toBe(5_200_000)
  })

  it('deja fuera a los que al empezar no eran de nadie', () => {
    const r = reconstructDraft(detalles, duennos, '2026-08-17')
    expect(r.players.find((p) => p.playerId === 55009)).toBeUndefined()
  })

  it('marca cuales conserva y cuales vendio', () => {
    const r = reconstructDraft(detalles, duennos, '2026-08-17')
    expect(r.players.find((p) => p.playerId === 28612)!.retained).toBe(true)
    expect(r.players.find((p) => p.playerId === 4753)!.retained).toBe(false)
  })

  it('declara los que no pudo valorar en vez de contarlos como cero', () => {
    // Contarlos como cero inflaria la caja inicial en silencio, que es
    // exactamente el tipo de fallo que este modulo viene a cerrar.
    const conHueco = new Map(detalles)
    conHueco.set(99999, { owners: [], values_chart: { points: [] } })
    const r = reconstructDraft(conHueco, new Map(duennos).set(99999, 15531409), '2026-08-17')
    expect(r.missingValue).toEqual([99999])
    expect(r.valueByManager['15531409']).toBe(9_084_000 + 1_373_000)
  })
})
