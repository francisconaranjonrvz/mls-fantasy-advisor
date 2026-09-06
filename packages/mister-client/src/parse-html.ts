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
    // El id vive en .player-avatar, igual que en el resto de vistas. Buscarlo
    // en .player-pic hacia que el mercado saliera siempre vacio pese a que la
    // pagina traia 43 jugadores: el contenedor existia, el id no estaba ahi.
    const idRaw =
      node.find('.player-avatar').first().attr('data-id_player') ??
      node.find('.player-pic').first().attr('data-id_player') ??
      node.attr('data-id_player')
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

/** Una temporada de LaLiga tiene 38 jornadas; nada por encima es un numero de jornada. */
const MAX_JORNADA = 38

/**
 * Jornada de liga en curso.
 *
 * Ojo con data-gwid: no es el numero de jornada sino el identificador GLOBAL de
 * jornada de Mister, compartido por todas las ligas. Contra la cuenta real
 * devolvia 4045, que se colaba tal cual en el diagnostico y descuadraba todo lo
 * que depende de cuantas jornadas se han jugado, desde la media de puntos hasta
 * la proyeccion del bote.
 *
 * Asi que se busca primero el numero visible ("JORNADA 6") y solo se acepta un
 * gwid si cae dentro del rango posible de una temporada.
 */
export function parseCurrentJornada(html: string): number | null {
  const visible = /JORNADA\s+(\d{1,2})(?!\d)/i.exec(html)
  if (visible?.[1]) {
    const n = Number.parseInt(visible[1], 10)
    if (n >= 1 && n <= MAX_JORNADA) return n
  }

  for (const re of [/data-gwid=["'](\d+)["']/, /gwid["']?\s*[:=]\s*["']?(\d+)/]) {
    const m = re.exec(html)
    const n = m?.[1] ? Number.parseInt(m[1], 10) : NaN
    if (Number.isFinite(n) && n >= 1 && n <= MAX_JORNADA) return n
  }

  return null
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
  // Mister lo llama "Compra por clausula", no "Fichaje por clausula".
  'compra por clausula': 'buyout_signing',
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

// ---------------------------------------------------------------------------
// Diagnostico del marcado
// ---------------------------------------------------------------------------

export interface HtmlShape {
  bytes: number
  /** Cuantos elementos encuentra cada selector consultado. */
  matches: { selector: string; count: number }[]
  /** Clases mas frecuentes, para descubrir como se llama ahora lo que buscamos. */
  topClasses: { name: string; count: number }[]
}

/**
 * Describe la forma de un fragmento HTML.
 *
 * Sirve para diagnosticar cuando un parser deja de encontrar nada. Saber que
 * ".player-row" ya no existe es util; saber ademas que ahora abundan
 * ".pl-row" o similar es lo que permite arreglarlo sin adivinar.
 */
export function describeHtml(html: string, selectors: string[], topN = 12): HtmlShape {
  const $ = cheerio.load(html)

  const counts = new Map<string, number>()
  $('[class]').each((_i, el) => {
    for (const c of ($(el).attr('class') ?? '').split(/\s+/)) {
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
  })

  return {
    bytes: html.length,
    matches: selectors
      .map((selector) => ({ selector, count: $(selector).length }))
      .filter((m) => m.count > 0),
    topClasses: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name, count]) => ({ name, count })),
  }
}

// ---------------------------------------------------------------------------
// Libro de movimientos en JSON
// ---------------------------------------------------------------------------

/** Quita etiquetas HTML de un texto. Mister mete <span> dentro de `reason`. */
export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Convierte el libro de movimientos que devuelve /ajax/sw/balance.
 *
 * Se prefiere esta via al raspado del HTML de /feed por tres motivos: el
 * importe y el signo vienen separados y sin formatear, la marca de tiempo es
 * unix en vez de texto localizado, y no depende de que no cambie el marcado.
 */
export function movementsToTransactions(
  movements: {
    ts?: number
    adate?: string
    reason?: string
    sign?: string
    amount?: number
    type?: string
    balance?: number
  }[],
  managerId: number,
  resolveManager?: (name: string) => number | undefined,
): Transaction[] {
  const out: Transaction[] = []

  for (const m of movements) {
    const magnitude = Math.abs(Math.round(Number(m.amount ?? 0)))
    if (!Number.isFinite(magnitude)) continue

    const { playerName, counterpartyName } = parseReason(stripTags(m.reason ?? ''))

    out.push({
      date: isoFromMovement(m),
      type: parseTransactionType(m.type ?? ''),
      // Mister marca las ENTRADAS con "+" y las salidas con una cadena VACIA,
      // no con "-". Comparar contra "-" no acertaba nunca y todas las compras
      // se guardaban en positivo, lo que inflaba el saldo reconstruido en
      // decenas de millones. La regla correcta es: positivo si y solo si
      // el signo es "+".
      amount: m.sign === '+' ? magnitude : -magnitude,
      managerId,
      counterpartyId: counterpartyName ? resolveManager?.(counterpartyName) : undefined,
      playerName,
      balanceAfter: typeof m.balance === 'number' ? Math.round(m.balance) : undefined,
    })
  }

  return out
}

function isoFromMovement(m: { ts?: number; adate?: string }): string {
  if (typeof m.ts === 'number' && m.ts > 0) return new Date(m.ts * 1000).toISOString()
  return parseMisterDate(m.adate ?? '') ?? ''
}

/**
 * Vuelca el ESQUELETO de los primeros elementos que casan con un selector.
 *
 * Devuelve etiquetas, clases y nombres de atributo, pero sustituye todo el
 * texto por su longitud. Sirve para escribir un parser nuevo mirando la forma
 * real del marcado sin publicar su contenido, que en el caso del feed de
 * actividad son nombres de rivales e importes de sus fichajes: justo lo que la
 * liga mantiene privado.
 */
export function describeStructure(
  html: string,
  selector: string,
  limit = 2,
  maxDepth = 5,
): string[] {
  const $ = cheerio.load(html)
  const out: string[] = []

  $(selector).slice(0, limit).each((i, el) => {
    const lines: string[] = [`--- ${selector} [${i}] ---`]

    const walk = (node: Element, depth: number): void => {
      const $n = $(node)
      const tag = node.tagName ?? '?'
      const cls = ($n.attr('class') ?? '').trim()
      // Solo los NOMBRES de los atributos de datos, nunca sus valores: un
      // data-id_player es inofensivo, pero no hace falta para escribir el parser.
      const attrs = Object.keys(node.attribs ?? {})
        .filter((a) => a !== 'class' && a !== 'style')
        .join(' ')
      const ownText = $n.clone().children().remove().end().text().trim()
      const textNote = ownText ? ` texto(${ownText.length})` : ''

      lines.push(
        '  '.repeat(depth) +
          `<${tag}${cls ? ` class="${cls}"` : ''}${attrs ? ` [${attrs}]` : ''}>${textNote}`,
      )

      if (depth < maxDepth) {
        $n.children().each((_j, child) => walk(child as Element, depth + 1))
      }
    }

    walk(el as Element, 0)
    out.push(lines.join('\n'))
  })

  return out
}

// ---------------------------------------------------------------------------
// Feed de actividad: traspasos entre managers
// ---------------------------------------------------------------------------

export interface FeedTransfer {
  playerId: number
  playerName: string
  /** Manager que entrega. undefined = lo vendia Mister (mercado). */
  fromManagerId?: number | undefined
  /** Manager que recibe. undefined = lo compra Mister. */
  toManagerId?: number | undefined
  price: number
  /** Texto de cabecera de la tarjeta, util para distinguir clausulazo de compra. */
  title: string
  /** Identificador de la tarjeta en el feed, para deduplicar. */
  cardId?: string | undefined
}

/**
 * Traspasos publicados en el feed de actividad.
 *
 * Es la unica via a los movimientos de los RIVALES: /ajax/sw/balance devuelve
 * solo el libro propio, asi que sin esto los saldos ajenos no se pueden
 * reconstruir y el analisis de clausulas se queda mudo.
 *
 * Estructura de cada tarjeta, comprobada contra la liga real:
 *   .card-transfer > .item > .player-row
 *     .player-avatar[data-id_player]   que jugador
 *     .flow                            quien lo entrega y quien lo recibe
 *       a.user[href="users/{id}/{slug}"]   un manager
 *       .avatar (sin enlace)               Mister, que no tiene pagina
 *       .price                             importe
 *
 * La direccion se toma del orden de aparicion dentro de .flow: primero quien
 * entrega, despues quien recibe. Es una inferencia, no un dato etiquetado, asi
 * que conviene contrastarla: los traspasos propios aparecen tanto aqui como en
 * el libro de balance, que si es autoritativo.
 */
export function parseFeedTransfers(html: string): FeedTransfer[] {
  const $ = cheerio.load(html)
  const out: FeedTransfer[] = []

  $('.card-transfer').each((_i, card) => {
    const cardId = $(card).attr('id') ?? undefined

    $(card).find('.item').each((_j, item) => {
      const node = $(item)

      const idRaw = node.find('.player-avatar').first().attr('data-id_player')
      const playerId = idRaw ? Number.parseInt(idRaw, 10) : NaN
      if (!Number.isFinite(playerId) || playerId <= 0) return

      const flow = node.find('.flow').first()
      if (flow.length === 0) return

      // Los participantes, en orden de aparicion. Un manager es un enlace a su
      // pagina; Mister no tiene pagina, asi que aparece como un div suelto.
      const parties: (number | undefined)[] = []
      flow.children().each((_k, child) => {
        const $child = $(child)
        const isUser = $child.hasClass('user') || $child.hasClass('avatar')
        if (!isUser) return
        const href = $child.attr('href') ?? $child.find('a').first().attr('href') ?? ''
        const m = /users\/(\d+)/.exec(href)
        parties.push(m?.[1] ? Number.parseInt(m[1], 10) : undefined)
      })

      out.push({
        playerId,
        playerName: node.find('.name').first().text().trim(),
        fromManagerId: parties[0],
        toManagerId: parties[1],
        price: parseEuros(flow.find('.price').first().text()),
        title: node.find('.title').first().text().replace(/\s+/g, ' ').trim(),
        cardId,
      })
    })
  })

  return out
}

/**
 * Convierte los traspasos del feed en movimientos por manager.
 *
 * Cada traspaso genera hasta dos apuntes simetricos: quien entrega ingresa el
 * importe y quien recibe lo paga. Los que tienen a Mister en un extremo generan
 * uno solo, porque el mercado no es un manager cuyo saldo interese.
 *
 * El tipo se infiere del titulo de la tarjeta: Mister distingue una compra de
 * mercado de un clausulazo, y esa diferencia importa porque un clausulazo
 * cambia el precio de compra del jugador y con el su futura clausula.
 */
export function feedTransfersToTransactions(
  transfers: FeedTransfer[],
  at: string,
  /**
   * Resuelve el nombre de un jugador por su id.
   *
   * Hace falta porque la tarjeta de traspaso del feed NO trae el nombre: su
   * player-row solo lleva el icono y el avatar con data-id_player, sin el
   * bloque .info que si tienen las filas del mercado. Sin resolverlo, los
   * apuntes salen sin nombre y no se pueden contrastar contra el libro propio,
   * que es la unica forma de verificar que la direccion inferida es correcta.
   */
  resolvePlayerName?: (playerId: number) => string | undefined,
): Transaction[] {
  const out: Transaction[] = []

  for (const t of transfers) {
    const esClausulazo = /cl[aá]usula/i.test(t.title)
    const playerName = t.playerName || resolvePlayerName?.(t.playerId)

    if (t.fromManagerId !== undefined) {
      out.push({
        date: at,
        type: esClausulazo ? 'buyout_sale' : 'sale',
        amount: t.price,
        managerId: t.fromManagerId,
        counterpartyId: t.toManagerId,
        playerId: t.playerId,
        playerName,
      })
    }

    if (t.toManagerId !== undefined) {
      out.push({
        date: at,
        type: esClausulazo ? 'buyout_signing' : 'purchase',
        amount: -t.price,
        managerId: t.toManagerId,
        counterpartyId: t.fromManagerId,
        playerId: t.playerId,
        playerName,
      })
    }
  }

  return out
}
