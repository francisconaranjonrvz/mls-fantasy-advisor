import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import {
  parseEuros, POSITION_BY_CODE,
  type Player, type OwnedPlayer, type MarketEntry, type Transaction,
  type TransactionType, type Position, type PlayerStatus,
} from '@mls/core'

/**
 * Parseo de los fragmentos HTML que devuelve Mister.
 *
 * Varias vistas (/market, /team, /users/{id}, /standings) no tienen endpoint
 * JSON: devuelven HTML parcial. Los selectores de aqui estan tomados de los
 * clientes de la comunidad que funcionan hoy, pero son la parte mas fragil del
 * sistema: un rediseno de Mister los rompe. Por eso el scraper valida el
 * resultado antes de escribir nada (ver checkSnapshotSanity en @mls/core).
 */

type Cheerio = cheerio.CheerioAPI

function textOf($: Cheerio, el: Element, sel: string): string {
  return $(el).find(sel).first().text().trim()
}

function readStatus($: Cheerio, el: Element): PlayerStatus {
  const node = $(el)
  if (node.find('.st-injury').length || node.find('use[href*="#injury"]').length) return 'injured'
  if (node.find('use[href*="#doubt"]').length) return 'doubt'
  if (node.find('use[href*="#sanction"]').length) return 'sanctioned'
  return 'ok'
}

/**
 * Un jugador que se fue de LaLiga sigue en tu plantilla pero puntua cero.
 * Mister lo marca quitandole el escudo o poniendole un icono de cruz.
 */
function readHasTeam($: Cheerio, el: Element): boolean {
  const node = $(el)
  if (node.find('use[href*="#cross"]').length || node.find('use[href*="#quit"]').length) return false
  return (
    node.find('a.team-logo').length > 0 ||
    node.find('img.team-logo').length > 0 ||
    node.find('.shield').length > 0
  )
}

function readTrend($: Cheerio, el: Element): 'up' | 'down' | 'flat' {
  const cls = $(el).find('.value-arrow').first().attr('class') ?? ''
  if (cls.includes('green')) return 'up'
  if (cls.includes('red')) return 'down'
  return 'flat'
}

function readPosition($: Cheerio, el: Element): Position {
  const code = $(el).find('.player-position').first().attr('data-position')
  return (code && POSITION_BY_CODE[code]) || 'MF'
}

/** Filas `.player-row`, presentes en /team, /market y /users/{id}. */
export function parsePlayerRows(html: string): Player[] {
  const $ = cheerio.load(html)
  const players: Player[] = []

  $('.player-row').each((_i, el) => {
    const idRaw = $(el).find('.player-avatar').first().attr('data-id_player')
    const id = idRaw ? Number.parseInt(idRaw, 10) : NaN
    if (!Number.isFinite(id) || id <= 0) return

    const name = textOf($, el, '.name')
    if (!name) return

    const pointsText = textOf($, el, '.points')
    const points = /^-?\d+$/.test(pointsText) ? Number.parseInt(pointsText, 10) : 0

    players.push({
      id,
      name,
      position: readPosition($, el),
      hasTeam: readHasTeam($, el),
      value: parseEuros(textOf($, el, '.underName')),
      points,
      status: readStatus($, el),
      trend: readTrend($, el),
    })
  })

  return players
}

/** Plantilla de un manager: filas de jugador enriquecidas con el dueno. */
export function parseSquad(html: string, ownerId: number): OwnedPlayer[] {
  return parsePlayerRows(html).map((p) => ({ ...p, ownerId, onMarket: false }))
}

/** Mercado abierto: `#list-on-sale li`. */
export function parseMarket(html: string): MarketEntry[] {
  const $ = cheerio.load(html)
  const entries: MarketEntry[] = []

  $('#list-on-sale li').each((_i, el) => {
    const node = $(el)
    const idRaw = node.find('.player-pic').first().attr('data-id_player')
    const id = idRaw ? Number.parseInt(idRaw, 10) : NaN
    if (!Number.isFinite(id) || id <= 0) return

    const ownerRaw = node.attr('data-owner')
    const owner = ownerRaw ? Number.parseInt(ownerRaw, 10) : NaN

    entries.push({
      playerId: id,
      price: parseEuros(node.attr('data-price') ?? ''),
      // data-owner ausente o 0 significa que lo saca Mister, no un rival.
      sellerId: Number.isFinite(owner) && owner > 0 ? owner : undefined,
      marketId: node.find('.btn-bid').first().attr('data-id_market') ?? undefined,
    })
  })

  return entries
}

/** Miembros de la liga, extraidos de los enlaces de /standings. */
export function parseStandingsMembers(html: string): { id: number; slug: string }[] {
  const found = new Map<number, string>()
  for (const m of html.matchAll(/href="(?:\/)?users\/(\d+)\/([^"?#]+)"/g)) {
    const id = Number.parseInt(m[1] ?? '', 10)
    const slug = m[2]
    if (Number.isFinite(id) && id > 0 && slug && !found.has(id)) found.set(id, slug)
  }
  return [...found].map(([id, slug]) => ({ id, slug }))
}

/** Jornada en curso, expuesta como data-gwid en /team. */
export function parseCurrentJornada(html: string): number | null {
  const m = /data-gwid=["'](\d+)["']/.exec(html) ?? /gwid["']?\s*[:=]\s*["']?(\d+)/.exec(html)
  const n = m?.[1] ? Number.parseInt(m[1], 10) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Etiquetas de tipo del libro de balance. Mister las sirve en ingles o en
 * espanol segun el idioma de la cuenta, asi que aceptamos ambas.
 *
 * "Penalizacion" es, contraintuitivamente, una modificacion de clausula: el
 * cargo por subirla o el abono por bajarla.
 */
const TRANSACTION_TYPES: Record<string, TransactionType> = {
  purchase: 'purchase',
  compra: 'purchase',
  sale: 'sale',
  venta: 'sale',
  'buyout signing': 'buyout_signing',
  'fichaje por clausula': 'buyout_signing',
  'buyout sale': 'buyout_sale',
  'venta por clausula': 'buyout_sale',
  'loan purchase': 'loan_purchase',
  'cesion recibida': 'loan_purchase',
  'loan sale': 'loan_sale',
  'cesion cedida': 'loan_sale',
  bonus: 'bonus',
  bonificacion: 'bonus',
  penalizacion: 'clause_change',
  penalty: 'clause_change',
  salario: 'salary',
  salary: 'salary',
  quiniela: 'quiniela',
}

const stripAccents = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

export function parseTransactionType(label: string): TransactionType {
  return TRANSACTION_TYPES[stripAccents(label)] ?? 'unknown'
}

/**
 * El campo "reason" tiene dos formas:
 *   "<Futbolista> to <Manager>"  o  "<Futbolista> a <Manager>"
 *   "Modificacion de clausula (X%) de <Futbolista>"
 *
 * Ojo: partir por " a " es ambiguo en espanol porque hay nombres que la
 * contienen. Probamos primero " to " y, en espanol, usamos la ULTIMA
 * aparicion de " a ", que es la que separa jugador de manager.
 */
export function parseReason(reason: string): {
  playerName?: string | undefined
  counterpartyName?: string | undefined
} {
  const trimmed = reason.trim()

  if (/modificaci[oó]n de cl[aá]usula/i.test(trimmed)) {
    const afterParen = trimmed.slice(trimmed.indexOf(')') + 1)
    const idx = afterParen.indexOf(' de ')
    if (idx !== -1) return { playerName: afterParen.slice(idx + 4).trim() }
    return {}
  }

  for (const sep of [' to ', ' a ']) {
    const idx = sep === ' to ' ? trimmed.indexOf(sep) : trimmed.lastIndexOf(sep)
    if (idx > 0) {
      const player = trimmed.slice(0, idx).trim()
      const other = trimmed.slice(idx + sep.length).trim()
      return {
        playerName: player || undefined,
        // "Mister" es el mercado, no un rival.
        counterpartyName: other && other !== 'Mister' ? other : undefined,
      }
    }
  }

  return {}
}

/** "12/09/2026 - 05:00" -> ISO. */
export function parseMisterDate(raw: string): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s*[-\u2013]\s*(\d{2}):(\d{2})/.exec(raw)
  if (!m) return null
  const [, d, mo, y, h, mi] = m
  return `${y}-${mo}-${d}T${h}:${mi}:00`
}

export interface RawBalanceEntry {
  date: string | null
  typeLabel: string
  reason: string
  amount: number
  balanceAfter?: number | undefined
}

/**
 * Libro de balance de /feed#balance: `ul.balance-history`.
 *
 * Es la fuente de verdad de tus propios movimientos, con importe con signo y
 * saldo resultante. El reconstructor de saldos rivales se calibra contra el:
 * si reproduce tu saldo real, funciona.
 */
export function parseBalanceHistory(html: string): RawBalanceEntry[] {
  const $ = cheerio.load(html)
  const out: RawBalanceEntry[] = []

  $('ul.balance-history li').each((_i, el) => {
    const node = $(el)
    const typeLabel = node.find('.type').first().text().trim()
    const reason = node.find('.reason').first().text().trim()
    const amountText = node.find('.amount').first().text().trim()
    if (!typeLabel && !reason && !amountText) return

    const dateNode = node.find('.date').first()
    const dateRaw = dateNode.attr('title') ?? dateNode.text()

    // parseEuros ya conserva un '-' inicial, asi que tomamos valor absoluto y
    // aplicamos el signo una sola vez. Mister usa ademas guiones tipograficos.
    const normalized = amountText.replace(/[–—−]/g, '-')
    const negative = normalized.includes('-')
    const magnitude = Math.abs(parseEuros(normalized))
    const balanceText = node.find('.balance').first().text().trim()

    out.push({
      date: parseMisterDate(dateRaw),
      typeLabel,
      reason,
      amount: negative ? -magnitude : magnitude,
      balanceAfter: balanceText ? parseEuros(balanceText) : undefined,
    })
  })

  return out
}

/** Convierte entradas crudas del libro de balance en transacciones del dominio. */
export function toTransactions(
  entries: RawBalanceEntry[],
  managerId: number,
  resolveManager?: (name: string) => number | undefined,
): Transaction[] {
  return entries.map((e) => {
    const { playerName, counterpartyName } = parseReason(e.reason)
    return {
      date: e.date ?? '',
      type: parseTransactionType(e.typeLabel),
      amount: e.amount,
      managerId,
      counterpartyId: counterpartyName ? resolveManager?.(counterpartyName) : undefined,
      playerName,
      balanceAfter: e.balanceAfter,
    }
  })
}
