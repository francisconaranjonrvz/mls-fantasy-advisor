import {
  MisterHttp, MisterEndpoints, authenticate, parsePlayerRows, parseSquad, parseMarket,
  parseStandingsMembers, parseCurrentJornada, parseBalanceHistory, toTransactions,
  readClause, readPurchasePrice,
} from '@mls/mister-client'
import { MLS_LEAGUE, parseEuros } from '@mls/core'
import type {
  LeagueSnapshot, Manager, Player, Transaction, MarketEntry,
} from '@mls/core'
import type { ScraperConfig } from './config.ts'

/**
 * Ingesta de una foto completa de la liga.
 *
 * Dos principios gobiernan este modulo:
 *
 * 1. Degradar, no reventar. Si falla una pieza (un rival concreto, el detalle
 *    de un jugador) se anota el fallo y se sigue. Un snapshot incompleto pero
 *    marcado como tal es util; un proceso caido no lo es.
 *
 * 2. Presupuesto de peticiones. El detalle por jugador es el unico sitio donde
 *    aparecen clausula y precio de compra, pero cuesta una peticion por
 *    jugador. Con 10 plantillas son cientos de llamadas, asi que se prioriza:
 *    primero tu plantilla entera, que es la que hay que proteger, y despues
 *    los rivales ordenados por lo golosos que resultan como objetivo.
 */

export interface IngestResult {
  snapshot: LeagueSnapshot
  transactions: Transaction[]
  balance: { balance: number; future: number; maxDebt: number } | null
  warnings: string[]
  enrichedCount: number
}

const log = (msg: string) => console.log(`[ingesta] ${msg}`)

/**
 * Convierte a numero un campo de la API que puede venir en varias formas.
 *
 * Mister no es consistente: el valor de equipo llegaba como texto con puntos de
 * millar ("62.400.000"), y Number() sobre eso da NaN. Ese NaN se propagaba
 * silenciosamente hasta el calculo del gasto maximo y tumbaba la validacion del
 * snapshot entero, con un mensaje que hablaba de tipos y no de la causa.
 *
 * Devuelve el respaldo cuando el valor no es interpretable, nunca NaN.
 */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : fallback
  if (typeof value === 'string') {
    const parsed = parseEuros(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

/**
 * Anota un aviso Y lo imprime en el momento.
 *
 * El motivo es una leccion aprendida a golpes: los avisos se acumulaban en un
 * array que solo se volcaba al final, y una ingesta que abortaba antes (por
 * ejemplo al no validar el esquema) no llegaba nunca a imprimirlos. El
 * resultado era un run rojo que decia que el snapshot era invalido, pero no
 * QUE habia fallado ni POR QUE, con todas las causas reales enterradas.
 *
 * Degradar en vez de reventar solo es buena idea si la degradacion se ve.
 */
function makeWarn(warnings: string[]) {
  return (msg: string): void => {
    warnings.push(msg)
    console.warn(`[ingesta] AVISO: ${msg}`)
  }
}

export async function ingest(config: ScraperConfig): Promise<IngestResult> {
  const warnings: string[] = []
  const warn = makeWarn(warnings)
  const http = new MisterHttp({ minDelayMs: config.throttleMs, jitterMs: config.throttleMs })

  log('autenticando...')
  const { method } = await authenticate(
    { session: config.session, email: config.email, password: config.password },
    http,
  )
  if (config.leagueId) http.leagueId = config.leagueId
  log(`autenticado por ${method} (liga ${http.leagueId ?? 'sin detectar'})`)

  // La cabecera x-league viaja en todas las llamadas a /ajax/sw. Si el id es
  // erroneo el servidor no falla de forma evidente: devuelve vacio, y el
  // sintoma aparece mucho despues como un catalogo sin jugadores.
  if (!http.leagueId) {
    warn(
      'no se detecto el id de liga. Las llamadas a /ajax/sw pueden devolver vacio. ' +
        'Definelo a mano en el secret MISTER_LEAGUE_ID.',
    )
  }

  const api = new MisterEndpoints(http)

  const teamHtml = await api.getTeamHtml()
  const currentJornada = parseCurrentJornada(teamHtml) ?? 0
  const ownSquadRaw = parsePlayerRows(teamHtml)
  log(`jornada ${currentJornada}, tu plantilla tiene ${ownSquadRaw.length} jugadores`)

  let balance: IngestResult['balance'] = null
  try {
    const b = await api.getBalance()
    balance = b
    log(`saldo ${b.balance}, gasto maximo ${b.maxDebt}`)
  } catch (err) {
    warn(`no se pudo leer el saldo: ${String(err)}`)
  }

  const members = parseStandingsMembers(await api.getStandingsHtml())
  if (members.length === 0) warn('no se encontro ningun miembro en /standings')
  log(`${members.length} miembros en la liga`)

  let players: Player[] = []
  try {
    players = (await api.getAllPlayers()).map(normalizePlayer).filter((p): p is Player => p !== null)
    log(`catalogo con ${players.length} jugadores`)
  } catch (err) {
    warn(`no se pudo leer el catalogo de jugadores: ${String(err)}`)
  }

  let market: MarketEntry[] = []
  try {
    market = parseMarket(await api.getMarketHtml())
    log(`${market.length} jugadores en el mercado`)
  } catch (err) {
    warn(`no se pudo leer el mercado: ${String(err)}`)
  }

  const managers: Manager[] = []
  for (const member of members) {
    try {
      const detail = await api.getManager(member.id)
      const squad = parseSquad(await api.getUserSquadHtml(member.id, member.slug), member.id)
      managers.push({
        id: member.id,
        name: detail.user?.name ?? member.slug,
        slug: member.slug,
        points: toNumber(detail.season?.points),
        average: toNumber(detail.season?.avg),
        // Si Mister no da un valor de equipo utilizable, la suma de la plantilla
        // es una aproximacion perfectamente valida.
        teamValue: toNumber(detail.value, squad.reduce((a, p) => a + p.value, 0)),
        squad,
      })
      log(`  ${member.slug}: ${squad.length} jugadores`)
    } catch (err) {
      warn(`no se pudo leer al manager ${member.slug}: ${String(err)}`)
    }
  }

  // Tu eres el manager cuya plantilla coincide con la que devuelve /team.
  const ownIds = new Set(ownSquadRaw.map((p) => p.id))
  const self = managers.find(
    (m) => m.squad.length > 0 && m.squad.filter((p) => ownIds.has(p.id)).length > m.squad.length / 2,
  )
  let selfId = 0
  if (self) {
    selfId = self.id
    self.balance = balance?.balance
    self.futureBalance = balance?.future

    // Mister no siempre devuelve max_debt, y contra la cuenta real venia a
    // cero. Es calculable: saldo mas el margen de deuda sobre el valor de
    // equipo, que en esta liga es el 25%.
    const reported = balance?.maxDebt ?? 0
    const computed = Math.round(
      (balance?.balance ?? 0) + self.teamValue * MLS_LEAGUE.maxDebtPctOfTeamValue,
    )
    self.maxDebt = reported > 0 ? reported : computed
    if (reported <= 0) {
      log(`gasto maximo calculado (Mister no lo devolvio): ${self.maxDebt}`)
    }
  } else {
    warn(
      `no se pudo identificar cual de los ${managers.length} managers eres tu. ` +
        `Tu plantilla (/team) tiene ${ownSquadRaw.length} jugadores y ninguna plantilla ` +
        'rival coincide con ella. Si arriba fallaron los managers, esa es la causa.',
    )
  }

  const enrichedCount = await enrichClauses(api, managers, selfId, config, warn)

  let transactions: Transaction[] = []
  try {
    const feedHtml = await api.getFeedHtml()
    const byName = new Map(managers.map((m) => [m.name.toLowerCase(), m.id]))
    transactions = toTransactions(parseBalanceHistory(feedHtml), selfId, (n) =>
      byName.get(n.toLowerCase()),
    )
    log(`${transactions.length} movimientos en tu libro de balance`)
    if (transactions.length === 0) {
      warn(
        'el libro de balance vino vacio; es posible que /feed cargue el historial por XHR aparte. ' +
          'Ver docs/INCOGNITAS.md punto 5.',
      )
    }
  } catch (err) {
    warn(`no se pudo leer el libro de balance: ${String(err)}`)
  }

  const snapshot: LeagueSnapshot = {
    takenAt: new Date().toISOString(),
    seasonId: config.seasonId,
    leagueId: http.leagueId ?? config.leagueId ?? 'desconocida',
    currentJornada,
    selfId,
    managers,
    market,
    players,
  }

  return { snapshot, transactions, balance, warnings, enrichedCount }
}

/**
 * Rellena clausula y precio de compra llamando al detalle por jugador.
 *
 * Es la parte cara: una peticion por jugador. El presupuesto se gasta primero
 * en tu plantilla, porque sin conocer tus propias clausulas no hay analisis de
 * riesgo posible, y despues en los rivales empezando por los que mas puntuan
 * por millon, que son los candidatos naturales a clausulazo.
 */
async function enrichClauses(
  api: MisterEndpoints,
  managers: Manager[],
  selfId: number,
  config: ScraperConfig,
  warn: (msg: string) => void,
): Promise<number> {
  const own = managers.find((m) => m.id === selfId)?.squad ?? []
  const rivals = managers
    .filter((m) => m.id !== selfId)
    .flatMap((m) => m.squad)
    .sort((a, b) => b.points / Math.max(1, b.value) - a.points / Math.max(1, a.value))

  const queue = [...own, ...rivals]
  const budget = config.maxPlayerDetails > 0 ? config.maxPlayerDetails : queue.length

  let done = 0
  let failures = 0

  for (const player of queue.slice(0, budget)) {
    try {
      const info = await api.getCommunityPlayerInfo(player.id)
      const clause = readClause(info)
      const purchase = readPurchasePrice(info)
      if (clause !== undefined) player.clause = clause
      if (purchase !== undefined) player.purchasePrice = purchase
      if (info.market && info.market.id !== undefined) {
        player.onMarket = true
        if (typeof info.market.price === 'number') player.askPrice = info.market.price
      }
      if (info.injury) player.status = 'injured'
      done++
    } catch (err) {
      failures++
      // Un fallo suelto no debe tumbar la ingesta, pero muchos si son senal
      // de que la sesion ha caducado o el endpoint ha cambiado.
      if (failures > 20) {
        warn(`demasiados fallos leyendo detalles de jugador (ultimo: ${String(err)}); se aborta`)
        break
      }
    }
  }

  if (budget < queue.length) {
    warn(
      `solo se enriquecieron ${budget} de ${queue.length} jugadores por el limite ` +
        'MAX_PLAYER_DETAILS; el resto usa la clausula por defecto estimada',
    )
  }
  log(`clausulas leidas para ${done} jugadores (${failures} fallos)`)
  return done
}

/** Normaliza un registro crudo del catalogo. Devuelve null si no es utilizable. */
function normalizePlayer(raw: Record<string, unknown>): Player | null {
  const id = Number(raw['id'])
  if (!Number.isFinite(id) || id <= 0) return null
  const name = String(raw['name'] ?? '').trim()
  if (!name) return null

  const positions = { '1': 'GK', '2': 'DF', '3': 'MF', '4': 'FW' } as const
  const posCode = String(raw['position'] ?? '3') as keyof typeof positions
  const ownerRaw = Number(raw['owner'])

  return {
    id,
    name,
    position: positions[posCode] ?? 'MF',
    // team a null significa que el jugador ya no esta en LaLiga: no puntuara.
    hasTeam: raw['team'] !== null && raw['team'] !== undefined,
    value: Math.round(Number(raw['value'] ?? 0)),
    points: Math.round(Number(raw['points'] ?? 0)),
    status: 'ok',
    ownerId: Number.isFinite(ownerRaw) && ownerRaw > 0 ? ownerRaw : undefined,
  }
}
