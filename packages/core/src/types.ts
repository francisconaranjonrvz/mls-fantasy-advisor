import type { Euros } from './money.ts'

export type Position = 'GK' | 'DF' | 'MF' | 'FW'

/** Codigos data-position del HTML de Mister. */
export const POSITION_BY_CODE: Record<string, Position> = {
  '1': 'GK',
  '2': 'DF',
  '3': 'MF',
  '4': 'FW',
}

export type PlayerStatus = 'ok' | 'doubt' | 'injured' | 'sanctioned' | 'no_team' | 'unknown'

export interface Player {
  id: number
  name: string
  position: Position
  /** Club real. Si el jugador se fue de LaLiga, `hasTeam` es false y no puntua. */
  club?: string | undefined
  hasTeam: boolean
  /** Valor de mercado actual. */
  value: Euros
  /** Puntos acumulados en la temporada. */
  points: number
  playedMatches?: number | undefined
  status: PlayerStatus
  /** Tendencia del valor en la ultima actualizacion. */
  trend?: 'up' | 'down' | 'flat' | undefined
  /**
   * Puntuaciones de las ultimas jornadas, la mas reciente primero.
   *
   * Es la unica serie temporal que Mister da gratis para los 523 jugadores, y
   * con la temporada recien empezada vale mas que el acumulado: dice cuantas
   * jornadas ha jugado de verdad y con que regularidad.
   */
  streak?: number[] | undefined
  /** Media por jornada segun Mister. */
  average?: number | undefined
  /** Proximo partido, para saber si la racha recibe rival facil o dificil. */
  nextFixture?: NextFixture | undefined
  /** Id del manager de la liga que lo posee. undefined = agente libre. */
  ownerId?: number | undefined
}

/** El partido que le toca al jugador en la jornada que viene. */
export interface NextFixture {
  /** Id del equipo rival en la nomenclatura de Mister. */
  rivalTeamId: number
  isHome: boolean
}

export interface OwnedPlayer extends Player {
  ownerId: number
  /** Lo que pago su dueno actual. Base del calculo de cláusula. */
  purchasePrice?: Euros | undefined
  /** Cláusula de rescision vigente. */
  clause?: Euros | undefined
  /**
   * Multiplicador de la clausula: 1,5 por defecto, y medio punto por tramo.
   *
   * Es dato publicado, no derivado, y con el lo que un manager gasto en subir
   * clausulas deja de acotarse y se calcula exacto. Sin el habia que deducir el
   * tramo dividiendo la clausula entre una base que solo se conoce a medias.
   */
  clauseMultiplier?: number | undefined
  /** ISO. Mientras no se alcance, el jugador esta blindado (7 dias tras fichaje). */
  shieldedUntil?: string | undefined
  /**
   * Dias de blindaje que le quedan segun Mister (campo `shield` del catalogo).
   *
   * Es dato directo, no inferido de la fecha de fichaje, asi que manda sobre
   * `shieldedUntil` cuando ambos existen.
   */
  shieldDays?: number | undefined
  onMarket: boolean
  askPrice?: Euros | undefined
}

export interface Manager {
  id: number
  name: string
  slug: string
  /** Puntos segun Mister (sin descontar sanciones del reglamento). */
  points: number
  average: number
  teamValue: Euros
  squad: OwnedPlayer[]
  /** Solo disponible para el usuario autenticado: Mister oculta el saldo ajeno. */
  balance?: Euros | undefined
  futureBalance?: Euros | undefined
  maxDebt?: Euros | undefined
}

export type TransactionType =
  | 'purchase'         // compra en el mercado
  | 'sale'             // venta al mercado o a otro manager
  | 'buyout_signing'   // pagaste una cláusula (clausulazo a favor)
  | 'buyout_sale'      // te pagaron una cláusula (te robaron)
  | 'loan_purchase'
  | 'loan_sale'
  | 'bonus'            // bonificacion de jornada
  | 'seed'             // el saldo que Mister te acredita al repartir la plantilla
  | 'clause_change'    // subir/bajar cláusula ("Penalización" en el feed)
  | 'salary'
  | 'quiniela'
  | 'unknown'

export interface Transaction {
  /** ISO 8601. */
  date: string
  type: TransactionType
  /** Importe con signo desde el punto de vista de `managerId`. */
  amount: Euros
  managerId: number
  /** Otro manager implicado. undefined = la operacion fue contra Mister/mercado. */
  counterpartyId?: number | undefined
  playerId?: number | undefined
  playerName?: string | undefined
  /** Saldo resultante, solo presente en el propio libro de balance. */
  balanceAfter?: Euros | undefined
  /** Jornada asociada (bonificaciones). */
  jornada?: number | undefined
  /**
   * Identificador estable del apunte en su fuente.
   *
   * Hace falta para acumular el libro entre ejecuciones sin duplicar. El libro
   * propio se deduplica por fecha y saldo resultante, que son datos exactos,
   * pero los apuntes del feed no traen saldo, asi que necesitan una clave
   * propia: el id del traspaso, o uno derivado para lo que no lo tiene.
   */
  reference?: string | undefined
}

/** Resultado de una jornada para un manager. */
export interface JornadaResult {
  jornada: number
  managerId: number
  /** Puntos brutos segun Mister. */
  points: number
  /** Puesto en esa jornada (1 = mejor). Determina la bonificacion. */
  rank?: number | undefined
}

/** Una foto completa de la liga en un instante. */
export interface LeagueSnapshot {
  /** ISO 8601 UTC. */
  takenAt: string
  seasonId: string
  leagueId: string
  currentJornada: number
  /** Id del manager autenticado (tu). */
  selfId: number
  managers: Manager[]
  /** Jugadores en el mercado abierto. */
  market: MarketEntry[]
  /** Catalogo completo de jugadores de LaLiga con su valor. */
  players: Player[]
}

export interface MarketEntry {
  playerId: number
  price: Euros
  /** Manager que lo vende. undefined = lo saca Mister (agente libre). */
  sellerId?: number | undefined
  marketId?: string | undefined
  /** ISO 8601 en que expira. */
  endsAt?: string | undefined
}
