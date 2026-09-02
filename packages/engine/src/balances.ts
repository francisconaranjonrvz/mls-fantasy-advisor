import type { Euros, Transaction, LeagueConfig } from '@mls/core'

/**
 * Reconstruccion del saldo de los rivales.
 *
 * Esta liga tiene "Permitir ver saldo de los rivales" en No, asi que Mister no
 * publica cuanto dinero tiene nadie. Pero si publica cada operacion con su
 * importe exacto, y todos empezaron con el mismo presupuesto, asi que el saldo
 * es deducible:
 *
 *   saldo(t) = presupuesto inicial
 *            - valor de la plantilla repartida al empezar
 *            + ventas - compras
 *            +/- clausulazos cobrados y pagados
 *            +/- modificaciones de clausula
 *            + bonificaciones de jornada     <- deterministas
 *            + quiniela                      <- NO observable
 *            - salarios                      <- interruptor sin confirmar
 *
 * Los dos ultimos terminos no se pueden observar desde fuera, asi que NO
 * devolvemos un numero: devolvemos un intervalo. No es una limitacion, es lo
 * que hace la respuesta accionable. Si el intervalo entero de un rival queda
 * por debajo de la clausula de tu jugador, estas a salvo con certeza; si lo
 * cruza, no lo estas. Un numero puntual inventado no distingue los dos casos.
 *
 * Ademas exprimimos las restricciones que impone el propio juego. Cada
 * operacion observada demuestra que el rival tenia con que pagarla, y cada
 * jornada en la que puntuo demuestra que no arranco en negativo, porque Mister
 * da cero puntos a quien empieza la jornada en rojo. Esas desigualdades
 * estrechan el intervalo gratis.
 */

export interface BalanceComponents {
  /** Presupuesto inicial menos el valor de la plantilla repartida. */
  initialCash: Euros
  purchases: Euros
  sales: Euros
  clausePaid: Euros
  clauseReceived: Euros
  /** Coste de subir clausulas y abono por bajarlas. */
  clauseAdjustments: Euros
  loans: Euros
  bonuses: Euros
  other: Euros
}

export interface BalanceEstimate {
  managerId: number
  /** Estimacion central. */
  estimate: Euros
  /** Escenario mas pobre compatible con lo observado. */
  low: Euros
  /** Escenario mas rico compatible con lo observado. */
  high: Euros
  /** true si es el saldo real leido de la API (solo el tuyo). */
  exact: boolean
  components: BalanceComponents
  /** Que impide dar un numero exacto. */
  unknowns: string[]
  /** Restricciones del juego usadas para estrechar el intervalo. */
  constraintsApplied: string[]
}

export interface ManagerLedger {
  managerId: number
  /**
   * Valor de la plantilla de 15 jugadores repartida al empezar. Si no se
   * conoce, se asume el reparto teorico y se ensancha el intervalo.
   */
  initialSquadValue?: Euros | undefined
  transactions: Transaction[]
  /** Si el historial no llega al inicio de temporada, la estimacion es debil. */
  historyComplete: boolean
  teamValue: Euros
  /** Puesto en cada jornada cerrada. Da la bonificacion exacta. */
  jornadaRanks?: { jornada: number; rank: number }[] | undefined
  /** Jornadas en las que puntuo: prueba de que no estaba en negativo. */
  scoredJornadas?: number[] | undefined
  /** Valor medio del once alineado, para acotar salarios si estuvieran activos. */
  averageLineupValue?: Euros | undefined
}

const sumBy = (txs: Transaction[], pred: (t: Transaction) => boolean): Euros =>
  txs.filter(pred).reduce((acc, t) => acc + t.amount, 0)

/** Suma las bonificaciones deterministas segun el puesto de cada jornada. */
export function bonusesFromRanks(
  ranks: { jornada: number; rank: number }[],
  config: LeagueConfig,
): Euros {
  return ranks.reduce((acc, r) => {
    const idx = Math.min(Math.max(r.rank, 1), config.jornadaRankBonus.length) - 1
    return acc + (config.jornadaRankBonus[idx] ?? 0)
  }, 0)
}

/** Formato 1X2 sobre todos los partidos: como mucho 10 aciertos por jornada. */
const MAX_QUINIELA_HITS_PER_JORNADA = 10

export function quinielaRange(jornadasPlayed: number, config: LeagueConfig): [Euros, Euros] {
  if (!config.quinielaEnabled || jornadasPlayed <= 0) return [0, 0]
  return [0, jornadasPlayed * MAX_QUINIELA_HITS_PER_JORNADA * config.quinielaPerHit]
}

/**
 * Rango del coste de salarios. El interruptor maestro figura en No, pero
 * conviven con el una base y un porcentaje activos, asi que hasta confirmarlo
 * en la app modelamos ambas ramas. Ver docs/INCOGNITAS.md.
 */
export function salaryRange(
  jornadasPlayed: number,
  averageLineupValue: Euros,
  config: LeagueConfig,
): [Euros, Euros] {
  if (jornadasPlayed <= 0) return [0, 0]
  const full = Math.round(averageLineupValue * config.salaries.pct * jornadasPlayed)
  if (config.salaries.enabled) return [-full, -full]
  return [-full, 0]
}

export function reconstructBalance(
  ledger: ManagerLedger,
  config: LeagueConfig,
  opts: { confirmedSalaries?: boolean } = {},
): BalanceEstimate {
  const txs = ledger.transactions
  const unknowns: string[] = []

  const initialSquadValue = ledger.initialSquadValue ?? config.initialBudget * 0.5
  if (ledger.initialSquadValue === undefined) {
    unknowns.push('no se conoce el valor de la plantilla repartida al empezar')
  }

  const components: BalanceComponents = {
    initialCash: config.initialBudget - initialSquadValue,
    purchases: sumBy(txs, (t) => t.type === 'purchase'),
    sales: sumBy(txs, (t) => t.type === 'sale'),
    clausePaid: sumBy(txs, (t) => t.type === 'buyout_signing'),
    clauseReceived: sumBy(txs, (t) => t.type === 'buyout_sale'),
    clauseAdjustments: sumBy(txs, (t) => t.type === 'clause_change'),
    loans: sumBy(txs, (t) => t.type === 'loan_purchase' || t.type === 'loan_sale'),
    bonuses: ledger.jornadaRanks
      ? bonusesFromRanks(ledger.jornadaRanks, config)
      : sumBy(txs, (t) => t.type === 'bonus'),
    other: sumBy(txs, (t) => t.type === 'salary' || t.type === 'quiniela' || t.type === 'unknown'),
  }

  const known =
    components.initialCash +
    components.purchases +
    components.sales +
    components.clausePaid +
    components.clauseReceived +
    components.clauseAdjustments +
    components.loans +
    components.bonuses +
    components.other

  const jornadasPlayed = ledger.jornadaRanks?.length ?? 0

  const [qLow, qHigh] = quinielaRange(jornadasPlayed, config)
  if (qHigh > 0) unknowns.push('los aciertos de quiniela no son observables')

  const [sLow, sHigh] = salaryRange(
    jornadasPlayed,
    ledger.averageLineupValue ?? Math.round(ledger.teamValue * 0.6),
    config,
  )
  if (sLow !== sHigh && !opts.confirmedSalaries) {
    unknowns.push('no esta confirmado si los salarios estan activos')
  }

  let low = known + qLow + sLow
  let high = known + qHigh + sHigh

  if (!ledger.historyComplete) {
    unknowns.push('el historial de movimientos no llega al inicio de temporada')
    // Sin historial completo esto es poco mas que una conjetura. Lo reflejamos
    // ensanchando el intervalo en vez de fingir precision.
    const slack = Math.round(config.initialBudget * 0.5)
    low -= slack
    high += slack
  }

  const constraintsApplied: string[] = []

  // Nadie puede empezar una jornada en negativo y aun asi puntuar.
  if ((ledger.scoredJornadas?.length ?? 0) > 0 && low < 0) {
    low = 0
    constraintsApplied.push('puntuo en alguna jornada, luego no arranco en negativo')
  }

  // Cada desembolso observado demuestra que tenia con que pagarlo.
  const outlays = txs.filter((t) => t.amount < 0).map((t) => -t.amount)
  if (outlays.length > 0) {
    const biggest = Math.max(...outlays)
    const impliedFloor = biggest - Math.round(ledger.teamValue * config.maxDebtPctOfTeamValue)
    if (impliedFloor > low) {
      low = impliedFloor
      constraintsApplied.push(
        'pago una operacion que solo cubria con ese saldo mas el margen de deuda',
      )
    }
  }

  if (high < low) high = low

  return {
    managerId: ledger.managerId,
    estimate: Math.round((low + high) / 2),
    low: Math.round(low),
    high: Math.round(high),
    exact: false,
    components,
    unknowns,
    constraintsApplied,
  }
}

/** Envuelve un saldo real (el tuyo) con la misma forma, sin incertidumbre. */
export function exactBalance(managerId: number, balance: Euros): BalanceEstimate {
  return {
    managerId,
    estimate: balance,
    low: balance,
    high: balance,
    exact: true,
    components: {
      initialCash: 0, purchases: 0, sales: 0, clausePaid: 0, clauseReceived: 0,
      clauseAdjustments: 0, loans: 0, bonuses: 0, other: 0,
    },
    unknowns: [],
    constraintsApplied: ['leido directamente de /ajax/balance'],
  }
}

export interface Calibration {
  actual: Euros
  reconstructed: Euros
  error: Euros
  errorPct: number
  withinInterval: boolean
}

/**
 * Contrasta la reconstruccion contra tu saldo real.
 *
 * Es la unica prueba honesta de que el metodo funciona: si aplicado a ti
 * reproduce el numero que Mister publica, aplicado a un rival tambien vale.
 * Si falla, el error aparece aqui y no camuflado en una recomendacion.
 */
export function calibrate(reconstructed: BalanceEstimate, actual: Euros): Calibration {
  const error = reconstructed.estimate - actual
  return {
    actual,
    reconstructed: reconstructed.estimate,
    error,
    errorPct: actual === 0 ? 0 : (error / Math.abs(actual)) * 100,
    withinInterval: actual >= reconstructed.low && actual <= reconstructed.high,
  }
}

/**
 * Capacidad maxima de gasto: saldo mas el margen de deuda del 25% del valor de
 * equipo.
 *
 * Para evaluar la AMENAZA de un rival se usa 'worst', que toma su cota
 * superior de saldo: al protegerse conviene equivocarse por exceso de
 * prudencia. Para planificar el gasto PROPIO se usa 'best', que toma la cota
 * inferior, por el mismo motivo invertido.
 */
export function spendingCapacity(
  estimate: BalanceEstimate,
  teamValue: Euros,
  config: LeagueConfig,
  scenario: 'worst' | 'expected' | 'best' = 'worst',
): Euros {
  const cash =
    scenario === 'worst' ? estimate.high : scenario === 'best' ? estimate.low : estimate.estimate
  return Math.round(cash + teamValue * config.maxDebtPctOfTeamValue)
}
