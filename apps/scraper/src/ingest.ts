import {
  MisterHttp, MisterEndpoints, authenticate, parsePlayerRows, parseSquad, parseMarket,
  parseStandingsMembers, parseCurrentJornada, movementsToTransactions,
  transfersToTransactions, poolsToTransactions, paymentsToTransactions,
  clauseChangesToTransactions,
  readClause, readPurchasePrice,
} from '@mls/mister-client'
import { MLS_LEAGUE, parseEuros, POSITION_BY_CODE } from '@mls/core'
import type {
  LeagueSnapshot, Manager, Player, PlayerStatus, Transaction, MarketEntry,
} from '@mls/core'
import type {
  BalanceInfo, RawPlayerRecord, LeagueProgression,
} from '@mls/mister-client'
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
  /** Libro propio, autoritativo: trae fecha exacta y saldo resultante. */
  transactions: Transaction[]
  /** Movimientos de rivales, del feed en JSON, con fecha e importe exactos. */
  rivalTransactions: Transaction[]
  /**
   * Tus propios apuntes segun el FEED, no segun tu libro de balance.
   *
   * Sirven para la unica verificacion que de verdad prueba el metodo:
   * reconstruir tu saldo usando solo lo que se ve de un rival y compararlo con
   * el saldo real. La calibracion habitual usa tu libro, asi que prueba la
   * aritmetica pero no el metodo.
   */
  feedSelfTransactions: Transaction[]
  /** Si el feed llego al principio de temporada. Decide si el saldo es exacto. */
  feedComplete: boolean
  balance: BalanceInfo | null
  /** Puesto de cada manager en cada jornada cerrada. Da bonificaciones exactas. */
  progression: LeagueProgression
  warnings: string[]
  enrichedCount: number
}

const log = (msg: string) => console.log(`[ingesta] ${msg}`)

/**
 * Los logs de Actions de un repositorio publico son publicos.
 *
 * El saldo y los movimientos son justo lo que la liga mantiene oculto entre
 * participantes, asi que no pueden acabar ahi. Se informa de que el dato se ha
 * leido y de su orden de magnitud, que es lo util para depurar, sin publicar la
 * cifra.
 */
function redacted(amount: number): string {
  if (!Number.isFinite(amount)) return 'ilegible'
  const digits = Math.abs(Math.round(amount)).toString().length
  return `${amount < 0 ? 'negativo' : 'positivo'}, ${digits} digitos`
}

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
  const snapshotAt = new Date().toISOString()
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
    log(`saldo leido (${redacted(b.balance)}), ${b.history.length} movimientos`)
  } catch (err) {
    warn(`no se pudo leer el saldo: ${String(err)}`)
  }

  // Puesto de cada manager en cada jornada cerrada. De aqui salen las
  // bonificaciones exactas, tambien las de los rivales, que hasta ahora eran
  // el termino que mas ensanchaba su intervalo de saldo.
  let progression: LeagueProgression = { jornadas: [], managers: [] }
  try {
    progression = await api.getProgression()
    log(
      `progresion: ${progression.jornadas.length} jornadas puntuadas ` +
        `(${progression.jornadas.map((j) => `J${j}`).join(', ')})`,
    )
  } catch (err) {
    warn(`no se pudo leer la progresion: ${String(err)}`)
  }

  const members = parseStandingsMembers(await api.getStandingsHtml())
  if (members.length === 0) warn('no se encontro ningun miembro en /standings')
  log(`${members.length} miembros en la liga`)

  let players: Player[] = []
  let catalogRaw: RawPlayerRecord[] = []
  try {
    catalogRaw = await api.getAllPlayers()
    players = catalogRaw.map(normalizePlayer).filter((p): p is Player => p !== null)
    const conDueno = players.filter((p) => p.ownerId !== undefined).length
    const enLaLiga = players.filter((p) => p.hasTeam).length
    log(`catalogo con ${players.length} jugadores (${conDueno} con dueno, ${enLaLiga} en LaLiga)`)
    // Estos tres contadores existen porque los tres campos han estado rotos en
    // silencio. Si vuelven a salir a cero, se ve aqui y no tres capas mas
    // abajo en forma de diagnostico sin senal.
    if (players.length > 0 && conDueno === 0) {
      warn('ningun jugador del catalogo tiene dueno: la clave de propiedad ha cambiado')
    }
    if (players.length > 0 && enLaLiga === 0) {
      warn('ningun jugador del catalogo tiene club: la clave de equipo ha cambiado')
    }
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
      log(`gasto maximo calculado, Mister no lo devolvio (${redacted(self.maxDebt)})`)
    }
  } else {
    warn(
      `no se pudo identificar cual de los ${managers.length} managers eres tu. ` +
        `Tu plantilla (/team) tiene ${ownSquadRaw.length} jugadores y ninguna plantilla ` +
        'rival coincide con ella. Si arriba fallaron los managers, esa es la causa.',
    )
  }

  // El catalogo manda sobre el HTML: trae estado, racha y proximo rival para
  // todos los jugadores, y el HTML de plantilla no.
  if (players.length > 0) {
    const cruzados = mergeCatalogIntoSquads(managers, players)
    const conClausula = mergeClausesFromCatalog(managers, catalogRaw)
    const enPlantillas = managers.reduce((a, m) => a + m.squad.length, 0)
    log(`catalogo cruzado con ${cruzados}/${enPlantillas} jugadores de plantilla`)
    log(`clausula conocida para ${conClausula} jugadores`)
    if (enPlantillas > 0 && cruzados < enPlantillas * 0.8) {
      warn(`solo ${cruzados} de ${enPlantillas} jugadores de plantilla estan en el catalogo`)
    }
  }

  // Ya solo queda por pedir el precio de compra, que es el unico dato que el
  // catalogo no trae y hace falta para calcular lo que cuesta subir una
  // clausula. Se pide jugador a jugador, asi que va con presupuesto.
  const enrichedCount = await enrichClauses(api, managers, selfId, config, warn)

  // El libro de movimientos NO esta en el HTML de /feed, como sugiere la
  // documentacion de la comunidad: viene en el mismo JSON que el saldo. Es
  // ademas mejor fuente, porque trae el importe sin formatear, el signo
  // aparte y la marca de tiempo unix.
  const byName = new Map(managers.map((m) => [m.name.toLowerCase(), m.id]))
  const transactions: Transaction[] = movementsToTransactions(
    balance?.history ?? [],
    selfId,
    (n) => byName.get(n.toLowerCase()),
  )
  log(`${transactions.length} movimientos en tu libro de balance`)
  if (transactions.length === 0) {
    warn('el libro de movimientos vino vacio: sin el no se pueden reconstruir los saldos rivales')
  }

  // --- Movimientos de los RIVALES, desde el feed de actividad ---
  //
  // /ajax/sw/balance devuelve solo el libro propio, asi que sin esto los saldos
  // ajenos no se pueden reconstruir y todo el analisis de clausulas se queda
  // mudo.
  //
  // Se lee de /ajax/feed, en JSON y paginado hasta el principio de temporada,
  // no del HTML de /feed. La diferencia no es de comodidad: el HTML solo trae
  // la primera pagina, 17 tarjetas de las 414 que hay, y no dice quien entrega
  // y quien recibe en un traspaso, asi que habia que deducirlo del orden en que
  // aparecen los dos managers dentro de un div. El JSON trae id_uc_from e
  // id_uc_to explicitos, y ademas publica la quiniela y las modificaciones de
  // clausula de todos, que en el HTML no se veian.
  let rivalTransactions: Transaction[] = []
  // Si el feed llega al principio de temporada, el libro de cada rival esta
  // completo y su saldo deja de ser una estimacion. Si no llega, hay que
  // seguir tratandolo como estimacion aunque casi todo cuadre.
  let feedComplete = false
  // Los apuntes del feed que te implican a TI. No entran en el analisis, que
  // para uno mismo usa el libro de balance, pero son la unica forma de probar
  // que el metodo aplicado a los rivales funciona: se reconstruye tu saldo con
  // ellos, a ciegas, y se compara con el real.
  let feedSelfTransactions: Transaction[] = []
  try {
    const { items, complete } = await api.getAllFeed()
    feedComplete = complete
    const categorias = new Map<string, number>()
    for (const it of items) {
      const c = typeof it['category'] === 'string' ? it['category'] : '?'
      categorias.set(c, (categorias.get(c) ?? 0) + 1)
    }
    log(
      `feed: ${items.length} entradas, ${complete ? 'llega al principio' : 'CORTADO'} ` +
        `(${[...categorias].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([c, n]) => `${c} ${n}`).join(', ')})`,
    )

    const porNombre = new Map(managers.map((m) => [m.name.toLowerCase().trim(), m.id]))
    const resolver = (nombre: string): number | undefined =>
      porNombre.get(nombre.toLowerCase().trim())

    // Las fechas del feed son relativas ("5h", "10d"), asi que hay que
    // resolverlas contra el instante del snapshot y no contra el reloj de cada
    // llamada, para que dos apuntes de la misma pasada sean comparables.
    const ahora = new Date(snapshotAt)
    const todos = [
      ...transfersToTransactions(items, ahora),
      ...poolsToTransactions(items, ahora),
      ...clauseChangesToTransactions(items, resolver, ahora),
      ...paymentsToTransactions(items, resolver, ahora),
    ]

    const sinFecha = todos.filter((t) => !t.date).length
    if (sinFecha > 0) {
      warn(
        `${sinFecha} apuntes del feed vienen sin fecha reconocible, asi que no entran en la ` +
          'comprobacion de que el saldo nunca bajo del margen de deuda',
      )
    }

    // Los propios se descartan: para uno mismo manda el libro de balance, que
    // es autoritativo y trae el saldo resultante de cada apunte.
    rivalTransactions = todos.filter((t) => t.managerId !== selfId)
    const propios = todos.filter((t) => t.managerId === selfId)
    feedSelfTransactions = propios
    log(`${todos.length} apuntes del feed, ${rivalTransactions.length} de rivales`)

    if (todos.length === 0) {
      warn('el feed no devolvio ningun apunte: sin ellos no hay saldos rivales')
    }
    if (!complete) {
      warn(
        'el feed se agoto antes de llegar al principio de temporada, asi que el libro de los ' +
          'rivales esta incompleto y su saldo sigue siendo una estimacion',
      )
    }

    // La verificacion sigue siendo necesaria aunque la direccion ya no se
    // deduzca: prueba que la lectura del feed y la del libro propio hablan de
    // lo mismo. Si no coincidieran, el error estaria en el lado de los rivales
    // y no daria ningun sintoma por si solo.
    if (propios.length > 0) {
      const check = crossCheckDirection(propios, transactions)
      log(
        `contraste con el libro propio: ${check.coinciden} coinciden, ` +
          `${check.discrepan} discrepan, ${check.sinPareja} sin pareja`,
      )
      if (check.discrepan > check.coinciden) {
        warn(
          'los apuntes propios del feed contradicen el libro de balance en la mayoria de los ' +
            'casos; los saldos rivales heredarian ese error',
        )
      }
    } else {
      warn(
        'ningun apunte del feed te implica a ti, asi que la lectura del feed no se ha podido ' +
          'contrastar contra el libro propio, que es la unica verificacion disponible',
      )
    }
  } catch (err) {
    warn(`no se pudo leer el feed de actividad: ${String(err)}`)
  }

  // El precio de compra que publica el feed es la base de la clausula de ese
  // jugador. Sin el hay que suponer que su clausula alta se pago subiendola,
  // y ese gasto que nunca existio ensancha el saldo estimado de su dueno.
  if (rivalTransactions.length > 0) {
    const conPrecio = applyFeedPurchasePrices(managers, rivalTransactions)
    log(`precio de compra anotado desde el feed para ${conPrecio} jugadores rivales`)
  }

  const snapshot: LeagueSnapshot = {
    takenAt: snapshotAt,
    seasonId: config.seasonId,
    leagueId: http.leagueId ?? config.leagueId ?? 'desconocida',
    currentJornada,
    selfId,
    managers,
    market,
    players,
  }

  return {
    snapshot,
    transactions,
    rivalTransactions,
    feedSelfTransactions,
    feedComplete,
    balance,
    progression,
    warnings,
    enrichedCount,
  }
}

/**
 * Rellena el precio de compra llamando al detalle por jugador.
 *
 * Es la parte cara de la ingesta: una peticion por jugador, con espera entre
 * ellas para no castigar a Mister. Desde que la clausula viene en el catalogo,
 * lo unico que hay que pedir aqui es el precio de compra, y ese solo hace
 * falta para la plantilla propia: es la base con la que se calcula lo que
 * cuesta subir una clausula, y las clausulas ajenas no se suben.
 *
 * De los rivales solo se piden los pocos a los que el catalogo no les dio
 * clausula, para no quedarse sin ese dato. La cola pasa asi de ciento
 * veintiocho peticiones a poco mas de quince.
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
    // Solo los huecos: si el catalogo ya dio la clausula, no hay nada que
    // preguntar sobre un jugador que nunca vas a proteger.
    .filter((p) => p.clause === undefined)
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
      // La clausula del catalogo es la buena; esta solo cubre huecos.
      if (clause !== undefined && player.clause === undefined) player.clause = clause
      if (purchase !== undefined) player.purchasePrice = purchase
      if (info.market && info.market.id !== undefined) {
        player.onMarket = true
        if (typeof info.market.price === 'number') player.askPrice = info.market.price
      }
      // Ojo: `injury` llega como array vacio para los jugadores sanos, y en
      // JavaScript [] es truthy. Escrito como `if (info.injury)` marcaba
      // lesionada a la plantilla entera, y con ello el once esperado se iba a
      // cero puntos. El estado autoritativo es el del catalogo; esto solo
      // rellena si alli no habia nada.
      if (hasInjury(info.injury) && player.status === 'ok') player.status = 'injured'
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
  log(`detalle pedido para ${done} jugadores (${failures} fallos, ${queue.length} en cola)`)
  return done
}

/**
 * Decide si el campo `injury` del detalle indica una lesion de verdad.
 *
 * Mister lo devuelve como array: vacio si el jugador esta sano, con entradas
 * si no. Un array vacio es truthy, asi que comprobarlo a secas da siempre que
 * si. Ha pasado: los catorce jugadores de la plantilla salian lesionados.
 */
export function hasInjury(injury: unknown): boolean {
  if (Array.isArray(injury)) return injury.length > 0
  if (injury && typeof injury === 'object') return Object.keys(injury).length > 0
  return Boolean(injury)
}

/**
 * Traduce el campo `status` del catalogo.
 *
 * Viene a null cuando el jugador esta sano, asi que la ausencia es informacion,
 * no un fallo. Se aceptan las variantes que Mister usa segun la vista.
 */
export function normalizeStatus(raw: unknown): PlayerStatus {
  // Solo se interpretan cadenas. Si Mister devolviera un objeto, convertirlo a
  // texto daria "[object Object]", que no casa con nada y saldria 'unknown':
  // parece prudente pero oculta un cambio de formato. Mejor declararlo asi.
  if (raw === null || raw === undefined) return 'ok'
  if (typeof raw !== 'string') return 'unknown'
  const v = raw.toLowerCase()
  if (!v || v === 'null' || v === 'ok') return 'ok'
  if (v.includes('injur') || v.includes('lesion')) return 'injured'
  if (v.includes('doubt') || v.includes('duda')) return 'doubt'
  if (v.includes('sanction') || v.includes('sancion')) return 'sanctioned'
  if (v.includes('quit') || v.includes('no_team')) return 'no_team'
  return 'unknown'
}

/**
 * Normaliza un registro crudo del catalogo. Devuelve null si no es utilizable.
 *
 * Los nombres de clave estan verificados contra el servidor (workflow
 * "Sondeo de endpoints"). Antes se leian `owner` y `team`, que no existen, y
 * el resultado era un catalogo de 523 jugadores en el que ninguno tenia dueno
 * ni club. Nada fallaba en rojo: el motor simplemente se quedaba ciego.
 */
export function normalizePlayer(raw: RawPlayerRecord): Player | null {
  const id = Number(raw.id)
  if (!Number.isFinite(id) || id <= 0) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null

  const posCode = String(raw.position ?? '3')
  const owner = Number(raw.id_uc)
  const club = Number(raw.id_team)
  const value = Math.round(Number(raw.value ?? 0))
  const prev = Math.round(Number(raw.prev_value ?? 0))

  // La racha llega de la jornada mas antigua a la mas reciente; el resto del
  // codigo la quiere al reves, con lo ultimo primero.
  const streak = Array.isArray(raw.streak)
    ? [...raw.streak].map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n)).reverse()
    : undefined

  const fixture = raw.match_info
  const player: Player = {
    id,
    name,
    position: POSITION_BY_CODE[posCode] ?? 'MF',
    // id_team a 0 o ausente significa que el jugador ya no esta en LaLiga.
    hasTeam: Number.isFinite(club) && club > 0,
    value,
    points: Math.round(Number(raw.points ?? 0)),
    status: normalizeStatus(raw.status),
    ownerId: Number.isFinite(owner) && owner > 0 ? owner : undefined,
  }
  if (streak && streak.length > 0) player.streak = streak
  if (Number.isFinite(Number(raw.avg))) player.average = Number(raw.avg)
  if (prev > 0 && value !== prev) player.trend = value > prev ? 'up' : 'down'
  else if (prev > 0) player.trend = 'flat'
  if (fixture && typeof fixture.rival_team_id === 'number') {
    player.nextFixture = { rivalTeamId: fixture.rival_team_id, isHome: fixture.is_home === true }
  }
  return player
}

/**
 * Vuelca sobre las plantillas todo lo que el catalogo ya sabe.
 *
 * El catalogo trae clausula, blindaje, estado, racha y proximo rival para los
 * 523 jugadores de la liga de una sola peticion. Las plantillas vienen de HTML,
 * que de eso solo trae una parte y peor. Cruzarlos por id deja el analisis
 * completo sin gastar una peticion por jugador.
 */
export function mergeCatalogIntoSquads(managers: Manager[], catalog: Player[]): number {
  const byId = new Map(catalog.map((p) => [p.id, p]))
  let matched = 0

  for (const manager of managers) {
    for (const player of manager.squad) {
      const cat = byId.get(player.id)
      if (!cat) continue
      matched++
      player.hasTeam = cat.hasTeam
      player.status = cat.status
      if (cat.value > 0) player.value = cat.value
      if (cat.points !== 0 || player.points === 0) player.points = cat.points
      if (cat.streak) player.streak = cat.streak
      if (cat.average !== undefined) player.average = cat.average
      if (cat.trend) player.trend = cat.trend
      if (cat.nextFixture) player.nextFixture = cat.nextFixture
    }
  }
  return matched
}

/**
 * Anota el precio de compra de los jugadores que cambiaron de manos en el feed.
 *
 * Importa por una razon que no salta a la vista. La clausula se calcula sobre
 * B = max(precio de compra, valor de mercado), asi que un jugador comprado caro
 * tiene una clausula alta sin que su dueno haya pagado un euro por subirla. Sin
 * saber el precio de compra hay que suponer que esa clausula alta SI se pago, y
 * ese gasto invisible ensancha el intervalo de saldo del rival.
 *
 * Con el precio delante, la cota de gasto en clausulas de casi todos esos
 * jugadores se va a cero, que es la verdad.
 */
export function applyFeedPurchasePrices(
  managers: Manager[],
  feedTransactions: Transaction[],
): number {
  // Del mas reciente al mas antiguo, para quedarnos con la ultima compra.
  const compras = new Map<string, number>()
  for (const t of feedTransactions) {
    if (t.playerId === undefined) continue
    if (t.type !== 'purchase' && t.type !== 'buyout_signing') continue
    const precio = Math.abs(t.amount)
    if (precio <= 0) continue
    compras.set(`${t.managerId}:${t.playerId}`, precio)
  }

  let anotados = 0
  for (const m of managers) {
    for (const p of m.squad) {
      const precio = compras.get(`${m.id}:${p.id}`)
      // No se pisa un precio leido del detalle del jugador, que es mejor dato.
      if (precio !== undefined && p.purchasePrice === undefined) {
        p.purchasePrice = precio
        anotados++
      }
    }
  }
  return anotados
}

/**
 * Clausula y blindaje directamente del catalogo.
 *
 * Es el hallazgo que hace barato el motor de riesgo: `clause` y `shield` vienen
 * para TODOS los jugadores en la misma respuesta paginada, no solo para los que
 * daba tiempo a consultar uno a uno.
 */
export function mergeClausesFromCatalog(managers: Manager[], raw: RawPlayerRecord[]): number {
  const byId = new Map<number, RawPlayerRecord>()
  for (const r of raw) {
    const id = Number(r.id)
    if (Number.isFinite(id) && id > 0) byId.set(id, r)
  }

  let done = 0
  for (const manager of managers) {
    for (const player of manager.squad) {
      const r = byId.get(player.id)
      if (!r) continue
      const clause = Math.round(Number(r.clause ?? 0))
      if (clause > 0) {
        player.clause = clause
        done++
      }
      const shield = Math.round(Number(r.shield ?? 0))
      if (Number.isFinite(shield) && shield > 0) player.shieldDays = shield
      if (r.id_market !== null && r.id_market !== undefined && r.id_market !== '') {
        player.onMarket = true
      }
    }
  }
  return done
}

/**
 * Contrasta la direccion inferida en el feed contra el libro propio.
 *
 * En el feed, quien entrega y quien recibe se deducen del ORDEN en que
 * aparecen, no de una etiqueta. Si esa inferencia estuviera invertida, los
 * saldos de todos los rivales saldrian del reves y el error seria silencioso.
 *
 * Los traspasos propios aparecen en ambos sitios, asi que sirven de piedra de
 * toque: para cada uno se comprueba que el signo deducido del feed coincide con
 * el que dice el libro de balance.
 */
function crossCheckDirection(
  fromFeed: Transaction[],
  ownLedger: Transaction[],
): { coinciden: number; discrepan: number; sinPareja: number } {
  let coinciden = 0
  let discrepan = 0
  let sinPareja = 0

  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

  for (const feedTx of fromFeed) {
    if (!feedTx.playerName) {
      sinPareja++
      continue
    }
    // Se casa por nombre normalizado e importe: el feed y el libro escriben los
    // nombres con acentos distintos segun la vista.
    const enLibro = ownLedger.find(
      (t) =>
        t.playerName !== undefined &&
        norm(t.playerName) === norm(feedTx.playerName!) &&
        Math.abs(t.amount) === Math.abs(feedTx.amount),
    )
    if (!enLibro) {
      sinPareja++
      continue
    }
    if (Math.sign(enLibro.amount) === Math.sign(feedTx.amount)) coinciden++
    else discrepan++
  }

  return { coinciden, discrepan, sinPareja }
}
