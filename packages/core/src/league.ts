import { M, type Euros } from './money.ts'

/**
 * Configuracion de la liga MLS (Malos Ligando Siempre), temporada 26-27.
 *
 * Los valores salen de dos fuentes, ambas en docs-liga/:
 *  - Las capturas de ajustes de Mister incluidas en REGLAMENTO LIGA MISTER.pdf (apartado 6).
 *  - Contrato Fantasy.pdf para las reglas economicas de dinero real.
 *
 * Si cambias un ajuste en Mister, cambialo aqui: el motor entero depende de estos numeros.
 */

export type MarketSpeed = 'normal' | 'intenso' | 'muy_intenso'
export type SalaryBasis = 'lineup' | 'squad'

export interface SalaryConfig {
  /**
   * Ajuste "Cobrar salarios por jugadores". En las capturas figura "No",
   * pero convive con una base y un porcentaje activos, lo que era
   * contradictorio. Ver docs/INCOGNITAS.md punto 1.
   */
  enabled: boolean
  /**
   * Si eso esta comprobado contra datos y no solo leido en una captura.
   *
   * Mientras no lo estaba, el motor tenia que evaluar las dos ramas y eso
   * anadia unos cinco millones de incertidumbre al saldo estimado de cada
   * rival. Ya lo esta: en 54 movimientos que cubren cuatro jornadas no hay un
   * solo cargo de salario, y la auditoria del libro contra su propio saldo
   * resultante cuadra al centimo. Si hubiera un cargo de ~900.000 por jornada
   * sin modelar, no cuadraria.
   */
  confirmed: boolean
  /** Porcentaje cobrado por jornada si `enabled`. */
  pct: number
  /** Sobre que se aplica el porcentaje. */
  basis: SalaryBasis
}

export interface LeagueConfig {
  seasonId: string
  name: string
  participants: number

  /** Presupuesto inicial total: valor de la plantilla repartida + saldo. */
  initialBudget: Euros
  /**
   * Fraccion del presupuesto que Mister entrega como PLANTILLA al empezar.
   *
   * OJO: esto NO es una regla del juego, aunque lo pareciera. Mi propio apunte
   * de reparto fueron 12.472.000 sobre 50M, el 24,944%, a un 0,056% del 25%
   * exacto, y me parecio demasiado redondo para ser casualidad. Lo era.
   *
   * Aplicandolo a los nueve rivales, seis salian comprando el primer dia mas
   * dinero del que esa fraccion les daba. Reconstruyendo lo que necesitaban
   * para que sus movimientos fueran posibles, las plantillas repartidas iban de
   * 18,6M a 52M: el reparto es aleatorio de verdad y yo generalice a partir de
   * una sola observacion, la mia.
   *
   * Se conserva solo como ultimo recurso, para cuando no hay libro del que
   * calcularlo. Lo que manda es estimateDraft() en packages/engine/src/draft.ts,
   * que lo saca jugador a jugador del feed.
   */
  initialSquadPctOfBudget: number
  /**
   * Margen alrededor de esa fraccion, tambien en fraccion del presupuesto.
   *
   * Generoso a proposito: la unica medida directa se desvia un 0,056% y aqui
   * se admite casi cuarenta veces mas, porque una sola observacion no da para
   * afinar. Aun asi deja el intervalo mucho mas estrecho que suponer a ojo.
   */
  initialSquadTolerance: number
  /** Jugadores aleatorios repartidos al empezar. */
  initialSquadSize: number

  maxSquadSize: number
  /** Puja/gasto maximo = saldo + este porcentaje del valor de equipo. */
  maxDebtPctOfTeamValue: number

  clausesEnabled: boolean
  /** Dias de blindaje de un jugador recien fichado. */
  clauseShieldDays: number
  maxClauseSigningsPerDay: number
  maxClauseLossesPerDay: number
  /** Horas antes del inicio de jornada en que se bloquean las cláusulas. */
  preJornadaClauseBlockHours: number

  marketSpeed: MarketSpeed
  /** Numero maximo de jugadores simultaneos en el mercado. */
  marketSlots: number
  /** Mister hace una oferta automatica por cada jugador puesto en venta. */
  autoOfferOnListing: boolean
  /** Se puede ofertar a un miembro por debajo del valor de mercado. */
  allowBelowMarketOffers: boolean

  loansEnabled: boolean
  /** Coste minimo de una cesion, como fraccion del valor del jugador. */
  loanMinCostPct: number

  salaries: SalaryConfig

  /** Bonificacion por puesto en la jornada. Indice 0 = 1er clasificado. */
  jornadaRankBonus: readonly Euros[]
  /** Bonificacion por punto conseguido. Desactivada en esta liga. */
  bonusPerPoint: Euros
  quinielaEnabled: boolean
  quinielaPerHit: Euros

  captainEnabled: boolean
  /** Cambios permitidos durante una jornada en curso. */
  maxInJornadaSubs: number
  /** Penalizacion por hueco vacio en el once. */
  emptySlotPenalty: number
  /** El despido/rescision cuesta creditos, y las compras por creditos estan a No. */
  despidoAvailable: boolean
  /** Mister oculta el saldo de los rivales en esta liga. */
  rivalBalanceVisible: boolean
}

export const MLS_LEAGUE: LeagueConfig = {
  seasonId: '2026-27',
  name: 'MLS (Malos Ligando Siempre)',
  participants: 10,

  initialBudget: M(50),
  initialSquadPctOfBudget: 0.75,
  initialSquadTolerance: 0.02,
  initialSquadSize: 15,

  maxSquadSize: 24,
  maxDebtPctOfTeamValue: 0.25,

  clausesEnabled: true,
  clauseShieldDays: 7,
  maxClauseSigningsPerDay: 3,
  maxClauseLossesPerDay: 3,
  preJornadaClauseBlockHours: 24,

  marketSpeed: 'normal',
  marketSlots: 20,
  autoOfferOnListing: true,
  allowBelowMarketOffers: false,

  loansEnabled: true,
  loanMinCostPct: 0.10,

  // Ajuste literal de las capturas: "Cobrar salarios por jugadores: No".
  salaries: { enabled: false, confirmed: true, pct: 0.01, basis: 'lineup' },

  // Escalera INVERTIDA: el ultimo cobra mas que el primero.
  jornadaRankBonus: [
    M(1.00), M(1.05), M(1.10), M(1.15), M(1.20),
    M(1.30), M(1.35), M(1.40), M(1.45), M(1.50),
  ],
  bonusPerPoint: 0,
  quinielaEnabled: true,
  quinielaPerHit: 25_000,

  captainEnabled: false,
  maxInJornadaSubs: 1,
  emptySlotPenalty: -4,
  despidoAvailable: false,
  rivalBalanceVisible: false,
} as const

/**
 * Reglas economicas de dinero real (Contrato Fantasy.pdf).
 * El ganador de la liga es quien mas PUNTOS acumula, no quien mas dinero tiene:
 * el dinero del juego es solo un medio.
 */
export interface ContractConfig {
  totalJornadas: number
  /** Cuota en euros reales por participante y jornada. */
  feePerJornada: number
  participants: number
  /** Reparto del bote: [1o, 2o, 3o]. */
  prizeSplit: readonly [number, number, number]
  /** Penalizacion en puntos por incumplir la norma de 1 cambio por jornada. */
  illegalSubPenalty: number
}

export const MLS_CONTRACT: ContractConfig = {
  totalJornadas: 38,
  feePerJornada: 1,
  participants: 10,
  prizeSplit: [0.60, 0.25, 0.15],
  illegalSubPenalty: 2,
} as const

/** Bote teorico maximo: 380 EUR aportados - 38 EUR de exenciones = 342 EUR. */
export const THEORETICAL_POT =
  MLS_CONTRACT.totalJornadas * MLS_CONTRACT.feePerJornada * MLS_CONTRACT.participants -
  MLS_CONTRACT.totalJornadas * MLS_CONTRACT.feePerJornada

/**
 * Momentos en que Mister mueve dinero y jugadores.
 * Con velocidad "Normal (con oferta adicional)" la compra-venta ocurre SOLO
 * a las 05:00 (UTC+1). Las 17:00 son unicamente una oferta adicional de
 * Mister sobre jugadores ya listados: no resuelven pujas ni rotan el mercado.
 */
export const MARKET_SCHEDULE = {
  /** Hora UTC+1 en que se resuelven pujas, se transfieren jugadores y rota el mercado. */
  resolutionHourUtcPlus1: 5,
  /** Hora UTC+1 de la oferta adicional (solo lado vendedor). */
  extraOfferHourUtcPlus1: 17,
} as const
