import { describe, it, expect } from 'vitest'
import type { RawFeedItem } from './endpoints.ts'
import {
  transfersToTransactions, poolsFromFeed, poolsToTransactions,
  clauseChangesFromFeed, clauseChangesToTransactions, tierOfMultiplier,
  paymentsToTransactions, transferKind, feedItemDate,
} from './feed-json.ts'

/**
 * Las entradas de este fichero estan copiadas de la respuesta real de
 * /ajax/feed, con los nombres cambiados. Es deliberado: los campos que
 * importan (id_uc_from, id_uc_to, hits, old_multiplier) no aparecen en ninguna
 * documentacion, y contra un fixture inventado por mi cualquier error de
 * nombre seria invisible porque yo escribiria el fixture con el mismo error.
 */
const TRASPASO: RawFeedItem = {
  id: 956247123,
  category: 'transfer',
  date: '2026-09-05 05:00:02',
  data: [
    {
      id_transfer: 546059565,
      id_uc_from: 15536263,
      id_uc_to: 0,
      type: 'normal',
      price: 4200000,
      days: 0,
      id_group: 822654417,
      id: 65347,
      name: 'Un Jugador',
      position: 3,
    },
  ],
}

const CLAUSULAZO: RawFeedItem = {
  id: 956247124,
  category: 'transfer',
  date: '2026-09-06 11:20:00',
  data: [
    {
      id_transfer: 546059566,
      id_uc_from: 15531722,
      id_uc_to: 15531409,
      type: 'clausula',
      price: 12000000,
      id: 28612,
      name: 'Otro Jugador',
    },
  ],
}

const QUINIELA: RawFeedItem = {
  id: 956247125,
  category: 'gameweek_end_pools',
  date: '2026-09-01 08:45:39',
  data: {
    id_gameweek: 4044,
    gameweek: 2,
    table: [
      { id: 15531409, name: 'Cuggito', hits: 6, amount: 150000, pools: 1 },
      { id: 15531722, name: 'Paquete fc', hits: 4, amount: 100000, pools: 1 },
      { id: 15531385, name: 'Elyisus', hits: 0, amount: 0, pools: 1 },
    ],
  },
}

const BAJADA_CLAUSULA: RawFeedItem = {
  id: 956247126,
  category: 'clauses_drops',
  date: '2026-09-02 12:53:31',
  data: [
    {
      id: 58986,
      name: 'Un Defensa',
      user: 'Peter Lim',
      value: 4000000,
      multiplier: 1.5,
      old_multiplier: 2.5,
    },
  ],
}

const PAGO: RawFeedItem = {
  id: 956247127,
  category: 'payment',
  date: '2026-09-03 10:00:00',
  data: {
    reason: 'Premio',
    payments: [
      { name: 'NIGGAS FC', amount: 50000, sign: '+', class: 'green' },
      { name: 'Lirolaaaa', amount: 20000, sign: '', class: 'red' },
    ],
  },
}

const RUIDO: RawFeedItem = { id: 0, category: 'admin', date: '2026-09-07 17:52:56', data: {} }

const TODO = [TRASPASO, CLAUSULAZO, QUINIELA, BAJADA_CLAUSULA, PAGO, RUIDO]

describe('traspasos: la direccion viene explicita, no se deduce', () => {
  /**
   * Esta es la mejora que mas riesgo quita. Raspando el HTML habia que
   * adivinar quien entrega y quien recibe por el ORDEN en que aparecen los dos
   * managers dentro de un div. Si esa inferencia se hubiera invertido, el
   * saldo de los nueve rivales habria salido del reves sin dar ningun sintoma.
   */
  it('una venta al mercado genera un solo apunte, en positivo', () => {
    const txs = transfersToTransactions([TRASPASO])
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      type: 'sale',
      amount: 4_200_000,
      managerId: 15536263,
      playerId: 65347,
      reference: '546059565',
    })
    // id_uc_to a 0 es Mister, que no tiene saldo que reconstruir.
    expect(txs[0]!.counterpartyId).toBeUndefined()
  })

  it('un traspaso entre managers genera los dos apuntes, con signos opuestos', () => {
    const txs = transfersToTransactions([CLAUSULAZO])
    expect(txs).toHaveLength(2)

    const vende = txs.find((t) => t.managerId === 15531722)!
    const compra = txs.find((t) => t.managerId === 15531409)!

    expect(vende.type).toBe('buyout_sale')
    expect(vende.amount).toBe(12_000_000)
    expect(vende.counterpartyId).toBe(15531409)

    expect(compra.type).toBe('buyout_signing')
    expect(compra.amount).toBe(-12_000_000)
    expect(compra.counterpartyId).toBe(15531722)

    // La liga es un juego de suma cero entre las dos partes.
    expect(vende.amount + compra.amount).toBe(0)
  })

  it('distingue clausulazo, cesion y compra normal', () => {
    expect(transferKind('normal')).toBe('normal')
    expect(transferKind('clausula')).toBe('clause')
    expect(transferKind('buyout')).toBe('clause')
    expect(transferKind('loan')).toBe('loan')
    expect(transferKind(undefined)).toBe('normal')
  })

  it('ignora las entradas que no son traspasos', () => {
    expect(transfersToTransactions([QUINIELA, RUIDO, PAGO])).toHaveLength(0)
  })

  it('lleva el id del traspaso como clave estable para no duplicar', () => {
    const dosVeces = [...transfersToTransactions(TODO), ...transfersToTransactions(TODO)]
    const claves = new Set(dosVeces.map((t) => `${t.reference}|${t.managerId}`))
    expect(claves.size).toBe(dosVeces.length / 2)
  })
})

describe('quiniela: resulta que si es observable', () => {
  /**
   * Estaba modelada como el unico termino irreducible del saldo rival: 25.000
   * por acierto, visible solo en el libro propio, 250.000 de incertidumbre por
   * jornada y rival. A final de temporada, casi diez millones. El feed publica
   * la tabla entera al cerrar cada jornada.
   */
  it('saca los aciertos y el importe de los diez managers', () => {
    const pools = poolsFromFeed([QUINIELA])
    expect(pools).toHaveLength(3)
    expect(pools[0]).toEqual({
      managerId: 15531409, jornadaId: 4044, hits: 6, amount: 150_000,
    })
    // 6 aciertos a 25.000 son los 150.000 que declara la tabla.
    expect(pools[0]!.hits * 25_000).toBe(pools[0]!.amount)
  })

  it('no genera apunte para quien no cobro nada', () => {
    const txs = poolsToTransactions([QUINIELA])
    expect(txs).toHaveLength(2)
    expect(txs.map((t) => t.managerId)).not.toContain(15531385)
  })

  it('fecha el cobro con la del cierre de jornada, no con la de hoy', () => {
    const txs = poolsToTransactions([QUINIELA])
    expect(txs[0]!.date).toBe('2026-09-01T08:45:39.000Z')
  })
})

describe('modificaciones de clausula', () => {
  it('trae el multiplicador anterior y el nuevo, no solo el resultado', () => {
    const cambios = clauseChangesFromFeed([BAJADA_CLAUSULA])
    expect(cambios).toHaveLength(1)
    expect(cambios[0]).toEqual({
      playerId: 58986,
      playerName: 'Un Defensa',
      ownerName: 'Peter Lim',
      value: 4_000_000,
      multiplier: 1.5,
      previousMultiplier: 2.5,
    })
  })
})

describe('cuanto cuesta o devuelve una modificacion de clausula', () => {
  const resolver = (n: string) => (n === 'Peter Lim' ? 15527099 : undefined)

  it('bajar de tramo devuelve la mitad de lo que costo subirlo', () => {
    // De 2,5 a 1,5 son dos tramos. Subirlos costo 0,2 x 4M x 2 = 1,6M, asi
    // que bajarlos devuelve la mitad: 800.000.
    const txs = clauseChangesToTransactions([BAJADA_CLAUSULA], resolver)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      type: 'clause_change',
      amount: 800_000,
      managerId: 15527099,
      playerId: 58986,
    })
  })

  it('subir de tramo cuesta el precio entero, no la mitad', () => {
    const subida: RawFeedItem = {
      ...BAJADA_CLAUSULA,
      data: [{ ...(BAJADA_CLAUSULA.data as Record<string, unknown>[])[0]!,
        multiplier: 2.5, old_multiplier: 1.5 }],
    }
    // Dos tramos sobre una base de 4M: 0,2 x 4M x 2 = 1,6M, en negativo.
    expect(clauseChangesToTransactions([subida], resolver)[0]!.amount).toBe(-1_600_000)
  })

  it('el tramo sale del multiplicador: 1,5 es no haber pagado nada', () => {
    expect(tierOfMultiplier(1.5)).toBe(0)
    expect(tierOfMultiplier(2.0)).toBe(1)
    expect(tierOfMultiplier(3.0)).toBe(3)
  })

  it('ignora al duenno que no se puede resolver', () => {
    expect(clauseChangesToTransactions([BAJADA_CLAUSULA], () => undefined)).toHaveLength(0)
  })
})

describe('pagos sueltos', () => {
  it('resuelve el manager por nombre y respeta el signo', () => {
    const porNombre = new Map([['niggas fc', 15536263], ['lirolaaaa', 15531463]])
    const txs = paymentsToTransactions([PAGO], (n) => porNombre.get(n.toLowerCase()))

    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ managerId: 15536263, amount: 50_000 })
    // Igual que en el libro propio: el signo ausente significa salida.
    expect(txs[1]).toMatchObject({ managerId: 15531463, amount: -20_000 })
  })

  it('descarta al manager que no se puede resolver en vez de inventarlo', () => {
    expect(paymentsToTransactions([PAGO], () => undefined)).toHaveLength(0)
  })
})

describe('fechas del feed', () => {
  it('convierte el formato de Mister a ISO ordenable', () => {
    expect(feedItemDate(TRASPASO)).toBe('2026-09-05T05:00:02.000Z')
  })

  it('prefiere la marca absoluta cuando viene, aunque haya relativa', () => {
    // Las entradas traen las dos: `created` absoluta y `date` relativa. Mirar
    // primero la relativa hacia que nunca se usara la buena, y con precision
    // de dias las compras y las ventas de una misma resolucion de mercado
    // caian en dias distintos.
    const item = { created: '2026-09-05 05:00:02', date: '2d' }
    expect(feedItemDate(item, new Date('2026-09-07T18:00:00Z')))
      .toBe('2026-09-05T05:00:02.000Z')
  })

  it('entiende las relativas, que es como llega casi todo el feed', () => {
    /**
     * Esto no es cosmetica. Con la fecha vacia no se pueden ordenar los
     * apuntes, y sin orden no se puede comprobar que el saldo de un rival
     * nunca bajo del margen de deuda, que es la restriccion que mas estrecha
     * su intervalo. Estaba pasando: todos los apuntes de rivales salian sin
     * fecha y esa comprobacion no llegaba a ejecutarse.
     */
    const ahora = new Date('2026-09-07T18:00:00.000Z')
    expect(feedItemDate({ date: '5h' }, ahora)).toBe('2026-09-07T13:00:00.000Z')
    expect(feedItemDate({ date: '10d' }, ahora)).toBe('2026-08-28T18:00:00.000Z')
    expect(feedItemDate({ date: 'hace 12 horas' }, ahora)).toBe('2026-09-07T06:00:00.000Z')
  })

  it('ordena bien lo relativo: mas dias es mas antiguo', () => {
    const ahora = new Date('2026-09-07T18:00:00.000Z')
    const viejo = feedItemDate({ date: '10d' }, ahora)!
    const nuevo = feedItemDate({ date: '2h' }, ahora)!
    expect(viejo < nuevo).toBe(true)
  })

  it('devuelve undefined si no hay fecha utilizable', () => {
    expect(feedItemDate({})).toBeUndefined()
    expect(feedItemDate({ date: '' })).toBeUndefined()
    expect(feedItemDate({ date: 'ayer' })).toBeUndefined()
  })
})
