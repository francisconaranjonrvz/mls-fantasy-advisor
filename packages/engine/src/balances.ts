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
   * Valor de la plantilla repartida al empezar. Si no se conoce, se aplica la
   * regla del reparto de la liga con su margen, en lugar de un punto.
   */
  initialSquadValue?: Euros | undefined
  transactions: Transaction[]
  /** Si el historial no llega al inicio de temporada, la estimacion es debil. */
  historyComplete: boolean
  /**
   * Si los cobros de quiniela de este manager estan observados.
   *
   * Estuvo modelada como la unica incognita irreducible: 25.000 por acierto,
   * visible solo en el libro propio. Resulta que el feed publica la tabla de
   * los diez al cerrar cada jornada, asi que cuando esos apuntes estan en el
   * libro no hay nada que estimar.
   */
  quinielaObserved?: boolean | undefined
  teamValue: Euros
  /**
   * Valor de plantilla inicial que se le SUPONE, por analogia con el propio.
   *
   * No es dato: es la observacion de la cuenta propia aplicada al rival, bajo
   * el supuesto de que el reparto inicial fue equivalente para todos. Estrecha
   * mucho el intervalo, asi que se mantiene como banda alrededor del valor
   * supuesto y nunca como cifra exacta.
   */
  initialSquadValueHint?: Euros | undefined
  /**
   * Cota superior de lo que pudo gastar en subir clausulas, si se conoce.
   *
   * El feed no publica las modificaciones de clausula de los rivales, asi que
   * ese gasto es invisible. Pero no es ilimitado: se deduce de las clausulas
   * que si se ven (ver maxClauseSpendForSquad). Sin esta cota habia que
   * suponer el 40% del valor del equipo, que son veintitantos millones y
   * dejaba el intervalo de todos los rivales pegado a cero por abajo.
   */
  maxClauseSpend?: Euros | undefined
  /**
   * Suelo de ese mismo gasto. Con el precio de compra conocido no es cero, y
   * eso estrecha el intervalo tambien por arriba, no solo por abajo.
   */
  minClauseSpend?: Euros | undefined
  /**
   * Si las SUBIDAS de clausula de este manager estan en `transactions`.
   *
   * Solo lo estan en el libro propio. El feed publica las bajadas, que son un
   * abono, pero no las subidas, que son el gasto. Tratar el historial como
   * completo por tener el feed entero dejaba ese gasto sin contar: en la
   * prueba a ciegas eran 2,38M que faltaban.
   */
  clauseRaisesObserved?: boolean | undefined
  /** Puesto en cada jornada cerrada. Da la bonificacion exacta. */
  jornadaRanks?: { jornada: number; rank: number }[] | undefined
  /**
   * Cuantas bonificaciones de jornada se han cobrado ya.
   *
   * Mister paga con retraso: la progresion listaba cuatro jornadas puntuadas
   * cuando en el libro solo habia dos bonificaciones. Sin acotarlo, la
   * reconstruccion le regalaba dos millones a cada rival.
   */
  paidBonusCount?: number | undefined
  /** Jornadas en las que puntuo: prueba de que no estaba en negativo. */
  scoredJornadas?: number[] | undefined
  /** Valor medio del once alineado, para acotar salarios si estuvieran activos. */
  averageLineupValue?: Euros | undefined
}

const sumBy = (txs: Transaction[], pred: (t: Transaction) => boolean): Euros =>
  txs.filter(pred).reduce((acc, t) => acc + t.amount, 0)

/**
 * Suma las bonificaciones deterministas segun el puesto de cada jornada.
 *
 * `paidCount` acota cuantas se han cobrado ya. Hace falta porque la
 * progresion lista las jornadas PUNTUADAS y Mister paga con retraso: contra la
 * cuenta real habia cuatro jornadas puntuadas y solo dos bonificaciones en el
 * libro, dos millones de diferencia que la reconstruccion a ciegas se apuntaba
 * de mas a cada rival.
 *
 * El numero de pagos es el mismo para los diez, asi que se cuenta en el libro
 * propio, que es exacto, y se aplica a todos.
 */
export function bonusesFromRanks(
  ranks: { jornada: number; rank: number }[],
  config: LeagueConfig,
  paidCount?: number,
): Euros {
  // Se pagan en orden, asi que las cobradas son las mas antiguas.
  const cobradas = paidCount === undefined
    ? ranks
    : [...ranks].sort((a, b) => a.jornada - b.jornada).slice(0, Math.max(0, paidCount))

  return cobradas.reduce((acc, r) => {
    const idx = Math.min(Math.max(r.rank, 1), config.jornadaRankBonus.length) - 1
    return acc + (config.jornadaRankBonus[idx] ?? 0)
  }, 0)
}

/**
 * Historia de como se ha ido acotando la plantilla inicial, que es el termino
 * que mas ha ensanchado siempre la estimacion del saldo ajeno.
 *
 * 1. Al principio se trataba como "no se nada" y se sumaba un margen de 25M a
 *    cada lado. Cincuenta millones de intervalo: ningun rival llegaba a ser
 *    amenaza cierta ni con su historial de traspasos delante.
 * 2. Luego se acoto entre el 40% y el 75% del presupuesto, razonando que
 *    quince jugadores de LaLiga no salen ni casi gratis ni por 50M. Diecisiete
 *    millones y medio.
 * 3. Al leer el libro propio aparecio el apunte del reparto: 12.472.000 sobre
 *    50M, o sea el 24,944%. A 28.000 euros del 25% exacto, un 0,056% del
 *    presupuesto, que es lo que cuesta cuadrar la plantilla con valores
 *    enteros de jugador.
 *
 * De ahi sale la regla que se usa hoy y que vive en la configuracion de la
 * liga: Mister reparte plantilla por el 75% del presupuesto y acredita el 25%.
 * El margen queda en un 2% del presupuesto, casi cuarenta veces la desviacion
 * medida, porque una sola observacion no da para afinar mas. Dos millones de
 * intervalo donde habia cincuenta.
 *
 * Ver `initialSquadPctOfBudget` en packages/core/src/league.ts.
 */

/** Formato 1X2 sobre todos los partidos: como mucho 10 aciertos por jornada. */
const MAX_QUINIELA_HITS_PER_JORNADA = 10

export function quinielaRange(jornadasPlayed: number, config: LeagueConfig): [Euros, Euros] {
  if (!config.quinielaEnabled || jornadasPlayed <= 0) return [0, 0]
  return [0, jornadasPlayed * MAX_QUINIELA_HITS_PER_JORNADA * config.quinielaPerHit]
}

/**
 * Rango del coste de salarios.
 *
 * Mientras el interruptor no estaba comprobado habia que evaluar las dos
 * ramas, y eso anadia el cargo entero como incertidumbre: unos cinco millones
 * por rival. Confirmado que estan apagados, el rango colapsa a cero.
 */
export function salaryRange(
  jornadasPlayed: number,
  averageLineupValue: Euros,
  config: LeagueConfig,
): [Euros, Euros] {
  if (jornadasPlayed <= 0) return [0, 0]
  const full = Math.round(averageLineupValue * config.salaries.pct * jornadasPlayed)
  if (config.salaries.enabled) return [-full, -full]
  if (config.salaries.confirmed) return [0, 0]
  return [-full, 0]
}

/**
 * La caja con la que arranco un manager, leida de su propio libro.
 *
 * Mister no reparte 50M de saldo: reparte una plantilla y acredita lo que
 * sobra. Ese apunte aparece una sola vez, antes de la primera jornada, y es
 * dato exacto, no estimacion. De el sale ademas el valor de la plantilla
 * inicial, que es la incognita que mas ensancha los intervalos de los rivales.
 *
 * Solo se puede leer del libro propio, porque el de los rivales no es visible.
 * Pero sirve igual para ellos: el reparto es el mismo mecanismo para todos, asi
 * que la caja propia es la mejor estimacion disponible de la ajena. Es una
 * suposicion, y como tal se declara alli donde se usa.
 */
export function observedInitialCash(transactions: Transaction[]): Euros | null {
  const seeds = transactions.filter((t) => t.type === 'seed')
  if (seeds.length === 0) return null
  return seeds.reduce((a, t) => a + t.amount, 0)
}

export function reconstructBalance(
  ledger: ManagerLedger,
  config: LeagueConfig,
  opts: { confirmedSalaries?: boolean } = {},
): BalanceEstimate {
  const txs = ledger.transactions
  const unknowns: string[] = []

  // Si no se conoce la plantilla inicial, se propaga como RANGO en lugar de
  // suponer un punto y ensanchar despues a bulto.
  const known0 = ledger.initialSquadValue !== undefined

  // La plantilla que reparte Mister vale una fraccion fija del presupuesto y
  // el resto se acredita como saldo. Se prefiere la medida propia si la hay,
  // porque incluye el redondeo real de esta liga, y si no, la regla.
  const porRegla = config.initialBudget * config.initialSquadPctOfBudget
  const centro = ledger.initialSquadValueHint ?? porRegla
  const margen = config.initialBudget * config.initialSquadTolerance

  const initialSquadValue = ledger.initialSquadValue ?? centro
  const initialSquadLow = known0 ? initialSquadValue : centro - margen
  const initialSquadHigh = known0 ? initialSquadValue : centro + margen

  if (!known0 && !txs.some((t) => t.type === 'seed')) {
    unknowns.push(
      `la plantilla inicial se toma de la regla del reparto (${Math.round(
        config.initialSquadPctOfBudget * 100,
      )}% del presupuesto) con un margen del ${Math.round(
        config.initialSquadTolerance * 100,
      )}%; es una regla observada una vez, no un dato de cada rival`,
    )
  }

  // Si el libro llega hasta el principio de temporada, trae el apunte con el
  // que Mister acredita la caja inicial. Entonces la caja de partida es cero y
  // la aporta ese apunte: sumar ademas "presupuesto menos plantilla" contaria
  // los mismos doce millones y medio dos veces.
  const seed = sumBy(txs, (t) => t.type === 'seed')
  const seedPresente = txs.some((t) => t.type === 'seed')

  const components: BalanceComponents = {
    initialCash: seedPresente ? seed : config.initialBudget - initialSquadValue,
    purchases: sumBy(txs, (t) => t.type === 'purchase'),
    sales: sumBy(txs, (t) => t.type === 'sale'),
    clausePaid: sumBy(txs, (t) => t.type === 'buyout_signing'),
    clauseReceived: sumBy(txs, (t) => t.type === 'buyout_sale'),
    clauseAdjustments: sumBy(txs, (t) => t.type === 'clause_change'),
    loans: sumBy(txs, (t) => t.type === 'loan_purchase' || t.type === 'loan_sale'),
    bonuses: ledger.jornadaRanks
      ? bonusesFromRanks(ledger.jornadaRanks, config, ledger.paidBonusCount)
      : sumBy(txs, (t) => t.type === 'bonus'),
    // El saldo inicial acreditado por Mister no se suma aqui: ya esta contado
    // en initialCash. Sumarlo otra vez duplicaria los doce millones y medio
    // con los que arranca cada manager.
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

  // Cuantas jornadas se han jugado, para acotar quiniela y salarios. Los
  // puestos son la mejor fuente, pero si no los hay valen las jornadas en las
  // que puntuo: antes, sin puestos, esto salia cero y el intervalo se
  // estrechaba fingiendo que no habia habido temporada.
  const jornadasPlayed = ledger.jornadaRanks?.length ?? ledger.scoredJornadas?.length ?? 0

  const [qLow, qHigh] = ledger.quinielaObserved
    ? ([0, 0] as [Euros, Euros])
    : quinielaRange(jornadasPlayed, config)
  if (qHigh > 0) unknowns.push('los aciertos de quiniela no son observables')

  const [sLow, sHigh] = salaryRange(
    jornadasPlayed,
    ledger.averageLineupValue ?? Math.round(ledger.teamValue * 0.6),
    config,
  )
  if (sLow !== sHigh && !opts.confirmedSalaries && !config.salaries.confirmed) {
    unknowns.push('no esta confirmado si los salarios estan activos')
  }

  // Mas plantilla inicial significa menos caja inicial: los extremos se cruzan.
  // Con el apunte de saldo inicial en el libro no hay nada que estimar: la caja
  // de partida es dato, asi que ese termino no abre el intervalo.
  let low = seedPresente
    ? known + qLow + sLow
    : known + qLow + sLow + (config.initialBudget - initialSquadHigh) - components.initialCash
  let high = seedPresente
    ? known + qHigh + sHigh
    : known + qHigh + sHigh + (config.initialBudget - initialSquadLow) - components.initialCash

  // El gasto en subir clausulas no se publica en ningun sitio, ni siquiera con
  // el feed entero: solo aparecen las bajadas. Asi que se acota a partir de las
  // clausulas que si se ven, salvo que venga ya en el libro, que es el caso del
  // propio.
  if (!ledger.clauseRaisesObserved) {
    const maxGasto = ledger.maxClauseSpend ?? (
      ledger.historyComplete ? 0 : Math.round(ledger.teamValue * 0.4)
    )
    low -= maxGasto
    high -= ledger.minClauseSpend ?? 0
    if (maxGasto > 0) {
      unknowns.push('las subidas de clausula no se publican; se acotan con las clausulas visibles')
    }
  }

  if (!ledger.historyComplete) {
    // Lo que falta no es "todo": son las bonificaciones de jornada y las
    // modificaciones de clausula. Ambas estan ACOTADAS por las reglas de la
    // liga, asi que el margen se calcula en vez de inventarse.
    //
    // Y si se conoce el puesto de cada jornada, la bonificacion deja de faltar:
    // ya esta contada, exacta, en components.bonuses. Volver a sumarla como
    // rango seria contarla dos veces y ensanchar el intervalo sin motivo.
    if (ledger.jornadaRanks) {
      unknowns.push(
        'el historial no incluye las modificaciones de clausula, que el feed no publica',
      )
    } else {
      unknowns.push(
        'el historial no incluye bonificaciones ni modificaciones de clausula, que el feed no publica',
      )
      const jornadas = Math.max(1, jornadasPlayed)
      low += Math.min(...config.jornadaRankBonus) * jornadas
      high += Math.max(...config.jornadaRankBonus) * jornadas
    }
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

  // Si las restricciones empujan la cota inferior por encima de la superior, es
  // que alguna suposicion es falsa para este rival. Lo normal es que sea la de
  // la plantilla inicial, que es la unica que no se mide en cada uno.
  //
  // Ante eso, ensanchar y decirlo, en vez de cerrar el intervalo por la fuerza
  // y presentar como cierto un numero que la propia aritmetica contradice.
  if (high < low) {
    unknowns.push(
      'las restricciones observadas contradicen la plantilla inicial supuesta para este rival: ' +
        'se ensancha el intervalo en vez de dar por buena la suposicion',
    )
    high = low + Math.abs(high - low) + config.initialBudget * config.initialSquadTolerance * 2
  }

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

// ---------------------------------------------------------------------------
// Auditoria del libro de movimientos
// ---------------------------------------------------------------------------

export interface HistoryAudit {
  /** Movimientos con saldo resultante, que son los auditables. */
  checked: number
  /** Movimientos en los que el saldo resultante no cuadra con el anterior mas el importe. */
  mismatches: {
    date: string
    type: string
    playerName?: string | undefined
    amount: Euros
    expected: Euros
    reported: Euros
    diff: Euros
  }[]
  /** Saldo antes del primer movimiento conocido, si se puede derivar. */
  derivedInitialCash: Euros | null
  /** Saldo tras el ultimo movimiento, segun el propio libro. */
  finalBalance: Euros | null
}

/**
 * Comprueba el libro de movimientos contra si mismo.
 *
 * Mister publica el saldo resultante de cada movimiento, asi que el historial
 * lleva su propia suma de verificacion: el saldo tras un movimiento tiene que
 * ser el anterior mas el importe. Si no cuadra, el error esta en como
 * interpretamos el signo o el tipo, no en el dato.
 *
 * Es una prueba mas fuerte que comparar solo el saldo final, porque senala
 * QUE movimiento concreto se interpreta mal en vez de dar una diferencia
 * global sin pista de donde viene.
 */
export function auditHistory(transactions: Transaction[]): HistoryAudit {
  // Del mas antiguo al mas reciente, que es como se acumula un saldo.
  const chrono = [...transactions]
    .filter((t) => t.balanceAfter !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date))

  // Se audita por INSTANTE, no movimiento a movimiento.
  //
  // Mister resuelve varias operaciones a la vez (el ciclo de mercado de las
  // 05:00 ejecuta todas las compras del dia de golpe) y les pone la misma marca
  // de tiempo, sin decir en que orden las aplico internamente. Encadenar saldos
  // uno a uno dentro de un grupo asi es imposible por construccion, y hacerlo
  // producia 17 descuadres falsos sobre un parseo que era correcto.
  //
  // Lo que si es comprobable, y es lo que importa, es que la suma de los
  // importes de un instante cuadre con el salto neto del saldo en ese instante.
  // Eso es independiente del orden.
  const groups: { date: string; movements: Transaction[] }[] = []
  for (const t of chrono) {
    const last = groups[groups.length - 1]
    if (last && last.date === t.date) last.movements.push(t)
    else groups.push({ date: t.date, movements: [t] })
  }

  const mismatches: HistoryAudit['mismatches'] = []

  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1]!
    const cur = groups[i]!

    // Saldo tras el grupo anterior: el mayor o menor no importa, pero dentro de
    // un grupo el ultimo saldo es el que queda. Se identifica como el que no es
    // punto de partida de ningun otro movimiento del grupo.
    const before = closingBalanceOf(prev)
    const after = closingBalanceOf(cur)
    const moved = cur.movements.reduce((acc, m) => acc + m.amount, 0)
    const diff = after - (before + moved)

    if (diff !== 0) {
      const worst = [...cur.movements].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]!
      mismatches.push({
        date: cur.date,
        type: cur.movements.length > 1 ? `${worst.type} (+${cur.movements.length - 1} mas)` : worst.type,
        playerName: worst.playerName,
        amount: moved,
        expected: before + moved,
        reported: after,
        diff,
      })
    }
  }

  const first = groups[0]
  const last = groups[groups.length - 1]

  return {
    checked: chrono.length,
    mismatches,
    // Antes del primer instante, el saldo era el de cierre menos lo que se
    // movio en el.
    derivedInitialCash: first
      ? closingBalanceOf(first) - first.movements.reduce((a, m) => a + m.amount, 0)
      : null,
    finalBalance: last ? closingBalanceOf(last) : null,
  }
}

/**
 * Saldo con el que cierra un instante.
 *
 * Dentro de un grupo simultaneo los saldos intermedios estan en orden
 * desconocido, pero el de cierre es identificable: es el unico que no es el
 * saldo de partida de ningun otro movimiento del grupo, es decir, aquel del que
 * no se puede restar ningun importe del grupo para caer en otro saldo del
 * grupo.
 */
function closingBalanceOf(group: { movements: Transaction[] }): number {
  const balances = group.movements.map((m) => m.balanceAfter!)
  if (balances.length === 1) return balances[0]!

  const set = new Set(balances)
  for (const m of group.movements) {
    // Si al deshacer este movimiento caemos en otro saldo del grupo, este no es
    // el cierre: hay un movimiento posterior.
    const isIntermediate = group.movements.some(
      (other) => other !== m && set.has(other.balanceAfter!) && other.balanceAfter! - other.amount === m.balanceAfter!,
    )
    if (!isIntermediate) return m.balanceAfter!
  }
  return balances[balances.length - 1]!
}
