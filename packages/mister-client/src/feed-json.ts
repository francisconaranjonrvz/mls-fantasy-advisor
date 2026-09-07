import type { Euros, Transaction, TransactionType } from '@mls/core'
import type { RawFeedItem } from './endpoints.ts'

/**
 * El feed de actividad, en JSON.
 *
 * Es la fuente que convierte el saldo de los rivales de estimacion en suma.
 * Hasta ahora se raspaba el HTML de `/feed`, que tiene dos problemas graves:
 * solo trae la primera pagina (17 tarjetas de las 414 que hay), y no dice
 * quien entrega y quien recibe en un traspaso, asi que habia que deducirlo del
 * ORDEN en que aparecen los dos managers dentro de un div.
 *
 * `/ajax/feed` devuelve lo mismo en JSON, paginado hasta el principio de
 * temporada, y con `id_uc_from` e `id_uc_to` explicitos. Ademas publica cosas
 * que el HTML no dejaba ver:
 *
 *  - `gameweek_end_pools`: los aciertos y el importe de la QUINIELA de los
 *    diez managers. Lo habia dado por no observable, y era el unico termino
 *    que impedia que el saldo rival fuera exacto.
 *  - `clauses_drops`: las modificaciones de clausula, con el multiplicador
 *    anterior y el nuevo.
 *  - `payment`: movimientos sueltos de dinero, con nombre e importe.
 *
 * Los nombres de campo estan verificados contra produccion, no supuestos.
 */

/** Un traspaso, tal cual viene en `data` de una entrada `transfer`. */
export interface RawTransfer {
  id_transfer?: number | string
  /** Manager que entrega. 0 significa que lo vendia Mister. */
  id_uc_from?: number | string
  /** Manager que recibe. 0 significa que lo compra Mister. */
  id_uc_to?: number | string
  /** "normal", y las variantes de clausula y cesion. */
  type?: string
  price?: number | string
  days?: number | string
  /** Id del jugador. */
  id?: number | string
  name?: string
  [k: string]: unknown
}

/** Una fila de la tabla de quiniela de `gameweek_end_pools`. */
export interface RawPoolRow {
  /** Id del manager en la liga. */
  id?: number | string
  name?: string
  hits?: number | string
  amount?: number | string
  [k: string]: unknown
}

export interface PoolResult {
  managerId: number
  jornadaId: number
  hits: number
  amount: Euros
}

/** Una modificacion de clausula publicada en `clauses_drops`. */
export interface ClauseChange {
  playerId: number
  playerName: string
  /** Nombre del manager duenno, que es lo unico que trae la entrada. */
  ownerName: string
  value: Euros
  multiplier: number
  previousMultiplier: number
}

const toInt = (v: unknown): number => {
  if (typeof v === 'number') return Math.round(v)
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  return 0
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

const asList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []

/** La lista de operaciones de una entrada, venga como lista o dentro de `data`. */
function itemList(item: RawFeedItem, key?: string): Record<string, unknown>[] {
  const data = item['data']
  if (Array.isArray(data)) return asList(data)
  if (data && typeof data === 'object' && key) return asList((data as Record<string, unknown>)[key])
  return []
}

/** Cuanto dura cada unidad de las fechas relativas del feed, en milisegundos. */
const UNIDADES: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  sem: 604_800_000,
  mes: 2_592_000_000,
  a: 31_536_000_000,
}

/**
 * Fecha de una entrada del feed, en ISO.
 *
 * Mister la sirve de dos formas y hay que aceptar las dos. Las entradas
 * recientes traen un relativo del estilo "5h" o "10d"; algunas traen la marca
 * absoluta "2026-09-07 05:00:01".
 *
 * No es un detalle de presentacion. Sin fecha no se pueden ordenar los apuntes,
 * y sin orden no se puede comprobar que el saldo de un rival nunca bajo del
 * margen de deuda, que es la restriccion que mas estrecha su intervalo. Con la
 * fecha vacia esa comprobacion simplemente no se ejecutaba.
 *
 * El relativo es aproximado por definicion, pero para ordenar basta y sobra.
 */
export function feedItemDate(item: RawFeedItem, now: Date = new Date()): string | undefined {
  // `created` PRIMERO, que es la marca absoluta ("2026-09-07 19:57:52").
  // `date` es el relativo que se pinta en pantalla ("17m", "10d").
  //
  // Lo tenia al reves y el relativo siempre esta presente, asi que nunca
  // llegaba a mirar el bueno. Con fechas aproximadas al dia, las compras y las
  // ventas de una misma resolucion de mercado caian en dias distintos, y el
  // recorrido del saldo mostraba minimos que nunca existieron: a paquete-fc le
  // exigia 7,4M mas de caja inicial de la que necesito.
  const raw = item['created'] ?? item['date']
  if (typeof raw !== 'string' || !raw.trim()) return undefined

  // Absoluta: "2026-09-07 05:00:01".
  const abs = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (abs) return `${abs[1]}-${abs[2]}-${abs[3]}T${abs[4]}:${abs[5]}:${abs[6]}.000Z`

  // Relativa: "5h", "10d", "3 sem", "hace 2 horas".
  const rel = /(\d+)\s*(sem|mes|[smhda])/i.exec(raw)
  if (rel) {
    const n = Number.parseInt(rel[1] ?? '', 10)
    const ms = UNIDADES[(rel[2] ?? '').toLowerCase()]
    if (Number.isFinite(n) && ms) return new Date(now.getTime() - n * ms).toISOString()
  }
  return undefined
}

/**
 * Traduce el campo `type` de un traspaso.
 *
 * Mister lo sirve en ingles y sin acentos segun la vista, asi que se compara
 * de forma laxa. Lo que importa es distinguir un clausulazo de una compra
 * normal: cambian el signo de la operacion para las dos partes y, sobre todo,
 * cambian el analisis de riesgo.
 */
export function transferKind(type: string | undefined): 'clause' | 'loan' | 'normal' {
  const t = (type ?? '').toLowerCase()
  if (t.includes('claus') || t.includes('buyout')) return 'clause'
  if (t.includes('loan') || t.includes('cesion') || t.includes('cesión')) return 'loan'
  return 'normal'
}

const SALE_TYPE: Record<'clause' | 'loan' | 'normal', TransactionType> = {
  clause: 'buyout_sale',
  loan: 'loan_sale',
  normal: 'sale',
}

const PURCHASE_TYPE: Record<'clause' | 'loan' | 'normal', TransactionType> = {
  clause: 'buyout_signing',
  loan: 'loan_purchase',
  normal: 'purchase',
}

/**
 * Convierte los traspasos del feed en apuntes contables.
 *
 * Cada traspaso genera hasta dos apuntes, uno por cada parte que sea un
 * manager de la liga. Si `id_uc_from` o `id_uc_to` valen 0, esa parte es
 * Mister y no tiene saldo que reconstruir.
 */
export function transfersToTransactions(items: RawFeedItem[], now = new Date()): Transaction[] {
  const out: Transaction[] = []

  for (const item of items) {
    if (item['category'] !== 'transfer') continue
    const date = feedItemDate(item, now) ?? ''

    for (const raw of itemList(item)) {
      const t = raw as RawTransfer
      const price = Math.abs(toInt(t.price))
      const playerId = toInt(t.id)
      const from = toInt(t.id_uc_from)
      const to = toInt(t.id_uc_to)
      const kind = transferKind(t.type)
      const ref = String(t.id_transfer ?? '')

      const comun = {
        date,
        amount: 0,
        managerId: 0,
        playerId: playerId > 0 ? playerId : undefined,
        playerName: typeof t.name === 'string' ? t.name : undefined,
        reference: ref || undefined,
      }

      if (from > 0) {
        out.push({
          ...comun,
          type: SALE_TYPE[kind],
          amount: price,
          managerId: from,
          counterpartyId: to > 0 ? to : undefined,
        })
      }
      if (to > 0) {
        out.push({
          ...comun,
          type: PURCHASE_TYPE[kind],
          amount: -price,
          managerId: to,
          counterpartyId: from > 0 ? from : undefined,
        })
      }
    }
  }
  return out
}

/**
 * Resultados de quiniela por manager y jornada.
 *
 * Este es el hallazgo que hace posible el saldo exacto. La quiniela paga
 * 25.000 por acierto y solo se veia en el libro propio, asi que era el unico
 * termino que quedaba sin observar en los rivales: 250.000 por jornada de
 * incertidumbre, que a final de temporada son casi diez millones. Resulta que
 * el feed publica la tabla completa al cerrar cada jornada.
 */
export function poolsFromFeed(items: RawFeedItem[]): PoolResult[] {
  const out: PoolResult[] = []

  for (const item of items) {
    if (item['category'] !== 'gameweek_end_pools') continue
    const data = item['data']
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue

    const jornadaId = toInt((data as Record<string, unknown>)['id_gameweek'])
    for (const raw of asList((data as Record<string, unknown>)['table'])) {
      const row = raw as RawPoolRow
      const managerId = toInt(row.id)
      if (managerId <= 0) continue
      out.push({
        managerId,
        jornadaId,
        hits: toInt(row.hits),
        amount: toInt(row.amount),
      })
    }
  }
  return out
}

/** Los cobros de quiniela, ya como apuntes contables. */
export function poolsToTransactions(items: RawFeedItem[], now = new Date()): Transaction[] {
  const fechaPorJornada = new Map<number, string>()
  for (const item of items) {
    if (item['category'] !== 'gameweek_end_pools') continue
    const data = item['data']
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const id = toInt((data as Record<string, unknown>)['id_gameweek'])
      const f = feedItemDate(item, now)
      if (id > 0 && f) fechaPorJornada.set(id, f)
    }
  }

  return poolsFromFeed(items)
    .filter((p) => p.amount !== 0)
    .map((p) => ({
      date: fechaPorJornada.get(p.jornadaId) ?? '',
      type: 'quiniela' as const,
      amount: p.amount,
      managerId: p.managerId,
      jornada: p.jornadaId,
      reference: `pool:${p.jornadaId}:${p.managerId}`,
    }))
}

/**
 * Modificaciones de clausula publicadas en el feed.
 *
 * Trae el multiplicador anterior y el nuevo, que es justo lo que hace falta
 * para saber cuanto costo o cuanto se recupero, en vez de acotarlo. La entrada
 * identifica al duenno por NOMBRE, no por id, asi que hay que resolverlo
 * contra la lista de managers.
 */
export function clauseChangesFromFeed(items: RawFeedItem[]): ClauseChange[] {
  const out: ClauseChange[] = []

  for (const item of items) {
    if (item['category'] !== 'clauses_drops') continue
    for (const raw of itemList(item)) {
      const playerId = toInt(raw['id'])
      if (playerId <= 0) continue
      out.push({
        playerId,
        playerName: typeof raw['name'] === 'string' ? raw['name'] : '',
        ownerName: typeof raw['user'] === 'string' ? raw['user'] : '',
        value: toInt(raw['value']),
        multiplier: toNum(raw['multiplier']),
        previousMultiplier: toNum(raw['old_multiplier']),
      })
    }
  }
  return out
}

/** Tramo al que corresponde un multiplicador de clausula. 1,5 es el tramo 0. */
export const tierOfMultiplier = (multiplier: number): number =>
  Math.max(0, Math.round((multiplier - 1.5) / 0.5))

/**
 * Las modificaciones de clausula, ya como apuntes contables.
 *
 * El importe sale de las reglas y no hay que acotarlo: subir un tramo cuesta
 * 0,2·B, y bajarlo devuelve la mitad de lo que costo, o sea 0,1·B. Con el
 * multiplicador anterior y el nuevo delante, la diferencia de tramos da el
 * importe exacto.
 *
 * La entrada identifica al duenno por NOMBRE, que es lo unico que trae, asi
 * que hay que resolverlo contra la lista de managers.
 */
export function clauseChangesToTransactions(
  items: RawFeedItem[],
  resolveManager: (name: string) => number | undefined,
  now = new Date(),
): Transaction[] {
  const out: Transaction[] = []

  for (const item of items) {
    if (item['category'] !== 'clauses_drops') continue
    const date = feedItemDate(item, now) ?? ''

    for (const c of clauseChangesFromFeed([item])) {
      const managerId = resolveManager(c.ownerName)
      if (managerId === undefined || c.value <= 0) continue

      const delta = tierOfMultiplier(c.multiplier) - tierOfMultiplier(c.previousMultiplier)
      if (delta === 0) continue

      // Bajar devuelve el 50% de lo que costo subir; subir cuesta el precio
      // entero. De ahi que el factor no sea el mismo en las dos direcciones.
      const amount = delta < 0
        ? Math.round(0.1 * c.value * -delta)
        : -Math.round(0.2 * c.value * delta)

      out.push({
        date,
        type: 'clause_change',
        amount,
        managerId,
        playerId: c.playerId,
        playerName: c.playerName,
        reference: `clause:${date}:${c.playerId}:${c.previousMultiplier}->${c.multiplier}`,
      })
    }
  }
  return out
}

/**
 * Pagos sueltos entre la liga y un manager, publicados en `payment`.
 *
 * Identifican al manager por nombre y traen el signo aparte del importe, igual
 * que el libro de balance propio.
 */
export function paymentsToTransactions(
  items: RawFeedItem[],
  resolveManager: (name: string) => number | undefined,
  now = new Date(),
): Transaction[] {
  const out: Transaction[] = []

  for (const item of items) {
    if (item['category'] !== 'payment') continue
    const data = item['data']
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const date = feedItemDate(item, now) ?? ''
    const motivo = (data as Record<string, unknown>)['reason']
    const reason = typeof motivo === 'string' ? motivo : ''

    for (const raw of asList((data as Record<string, unknown>)['payments'])) {
      const name = typeof raw['name'] === 'string' ? raw['name'] : ''
      const managerId = resolveManager(name)
      if (managerId === undefined) continue
      const magnitude = Math.abs(toInt(raw['amount']))
      // Igual que en el libro propio, el signo va aparte y su ausencia
      // significa salida, no entrada.
      const amount = raw['sign'] === '+' ? magnitude : -magnitude
      out.push({
        date,
        type: 'unknown',
        amount,
        managerId,
        playerName: reason || undefined,
        reference: `payment:${date}:${managerId}:${amount}`,
      })
    }
  }
  return out
}
