import {
  MisterHttp, MisterEndpoints, login, parsePlayerRows, parseSquad, parseMarket,
  parseStandingsMembers, parseCurrentJornada, parseBalanceHistory, toTransactions,
  readClause, readPurchasePrice,
} from '@mls/mister-client'
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

export async function ingest(config: ScraperConfig): Promise<IngestResult> {
  const warnings: string[] = []
  const http = new MisterHttp({ minDelayMs: config.throttleMs, jitterMs: config.throttleMs })

  log('autenticando...')
  await login({ email: config.email, password: config.password }, http)
  if (config.leagueId) http.leagueId = config.leagueId
  log(`sesion lista (liga ${http.leagueId ?? 'auto'})`)

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
    warnings.push(`no se pudo leer el saldo: ${String(err)}`)
  }

  const members = parseStandingsMembers(await api.getStandingsHtml())
  if (members.length === 0) warnings.push('no se encontro ningun miembro en /standings')
  log(`${members.length} miembros en la liga`)

  let players: Player[] = []
  try {
    players = (await api.getAllPlayers()).map(normalizePlayer).filter((p): p is Player => p !== null)
    log(`catalogo con ${players.length} jugadores`)
  } catch (err) {
    warnings.push(`no se pudo leer el catalogo de jugadores: ${String(err)}`)
  }

  let market: MarketEntry[] = []
  try {
    market = parseMarket(await api.getMarketHtml())
    log(`${market.length} jugadores en el mercado`)
  } catch (err) {
    warnings.push(`no se pudo leer el mercado: ${String(err)}`)
  }

  const managers: Manager[] = []
  for (const member of members) {
    try {
      const detail = await api.getManager(member.id)
      const squad = parseSquad(await api.getUserSquadHtml(member.id), member.id)
      managers.push({
        id: member.id,
        name: detail.user?.name ?? member.slug,
        slug: member.slug,
        points: Math.round(Number(detail.season?.points ?? 0)),
        average: Number(detail.season?.avg ?? 0),
        teamValue: Math.round(Number(detail.value ?? squad.reduce((a, p) => a + p.value, 0))),
        squad,
      })
      log(`  ${member.slug}: ${squad.length} jugadores`)
    } catch (err) {
      warnings.push(`no se pudo leer al manager ${member.slug}: ${String(err)}`)
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
    self.maxDebt = balance?.maxDebt
  } else {
    warnings.push('no se pudo identificar cual de los managers eres tu')
  }

  const enrichedCount = await enrichClauses(api, managers, selfId, config, warnings)

  let transactions: Transaction[] = []
  try {
    const feedHtml = await api.getFeedHtml()
    const byName = new Map(managers.map((m) => [m.name.toLowerCase(), m.id]))
    transactions = toTransactions(parseBalanceHistory(feedHtml), selfId, (n) =>
      byName.get(n.toLowerCase()),
    )
    log(`${transactions.length} movimientos en tu libro de balance`)
    if (transactions.length === 0) {
      warnings.push(
        'el libro de balance vino vacio; es posible que /feed cargue el historial por XHR aparte. ' +
          'Ver docs/INCOGNITAS.md punto 5.',
      )
    }
  } catch (err) {
    warnings.push(`no se pudo leer el libro de balance: ${String(err)}`)
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
  warnings: string[],
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
    } catch {
      failures++
      // Un fallo suelto no debe tumbar la ingesta, pero muchos si son senal
      // de que la sesion ha caducado o el endpoint ha cambiado.
      if (failures > 20) {
        warnings.push('demasiados fallos leyendo detalles de jugador; se aborta el enriquecido')
        break
      }
    }
  }

  if (budget < queue.length) {
    warnings.push(
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
