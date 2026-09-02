import type { Euros } from './money.js'

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
  /** Racha de puntuaciones recientes (mas reciente primero). */
  streak?: number[] | undefined
  /** Id del manager de la liga que lo posee. undefined = agente libre. */
  ownerId?: number | undefined
}

export interface OwnedPlayer extends Player {
  ownerId: number
  /** Lo que pago su dueno actual. Base del calculo de cláusula. */
  purchasePrice?: Euros | undefined
  /** Cláusula de rescision vigente. */
  clause?: Euros | undefined
  /** ISO. Mientras no se alcance, el jugador esta blindado (7 dias tras fichaje). */
  shieldedUntil?: string | undefined
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
