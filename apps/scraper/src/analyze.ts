import type { LeagueProgression } from '@mls/mister-client'
import {
  MLS_LEAGUE, MLS_CONTRACT,
  type LeagueSnapshot, type Transaction, type Euros, type Player,
} from '@mls/core'
import {
  buildValuationContext, reconstructBalance, spendingCapacity,
  calibrate, assessSquad, planProtection, findRaidTargets, planRaids, findDeadweight,
  optimizeLineup, bestSubstitution, auditHistory, rankMarketBuys, observedInitialCash,
  maxClauseSpendForSquad, minClauseSpendForSquad,
  type BalanceEstimate, type ThreatAssessment, type RaidTarget, type RivalCapacity,
  type Calibration, type HistoryAudit,
} from '@mls/engine'

/**
 * Convierte una foto cruda de la liga en un diagnostico accionable.
 *
 * Todo lo que hay aqui es determinista. La IA que se monta encima no calcula
 * ni un solo numero: recibe este objeto ya resuelto y se limita a explicarlo y
 * a razonar sobre lo cualitativo (lesiones, rotaciones, contexto). Esa
 * separacion es deliberada, porque un modelo de lenguaje equivocandose en una
 * resta de millones es exactamente el fallo que no nos podemos permitir.
 */

export interface RivalView {
  managerId: number
  name: string
  points: number
  teamValue: Euros
  balance: BalanceEstimate
  /** Capacidad de gasto en su escenario mas rico: asi se mide la amenaza. */
  threatCapacity: Euros
  squadSize: number
}

export interface Diagnosis {
  generatedAt: string
  seasonId: string
  currentJornada: number
  self: {
    managerId: number
    name: string
    points: number
    teamValue: Euros
    balance: Euros | null
    maxSpend: Euros | null
    rank: number
    pointsToLeader: number
  }
  rivals: RivalView[]
  /** Contraste de la reconstruccion contra tu saldo real, usando tu libro. */
  calibration: Calibration | null
  /**
   * El mismo contraste pero usando SOLO lo que se ve de un rival: el feed, la
   * regla del reparto y los puestos por jornada, sin tocar tu libro de
   * balance.
   *
   * Es la unica verificacion que prueba el metodo en vez de la aritmetica. Si
   * esta cuadra, los saldos rivales son de fiar; si no, dice cuanto falta.
   */
  blindCalibration: Calibration | null
  /**
   * Auditoria del libro de movimientos contra su propio saldo resultante.
   *
   * Es la prueba de que la logica de sumar movimientos es correcta, y por tanto
   * de que se puede aplicar a los rivales. Mas util que la calibracion global
   * porque senala QUE movimiento se interpreta mal, no solo cuanto falla.
   */
  historyAudit: {
    checked: number
    mismatches: number
    derivedInitialCash: Euros | null
    worst: { date: string; type: string; playerName?: string | undefined; diff: Euros } | null
  } | null
  threats: ThreatAssessment[]
  /**
   * Jugadores que nadie puede robarte con seguridad, pero cuya seguridad
   * tampoco esta confirmada porque no conocemos el saldo exacto de los
   * rivales. Se cuentan aparte para no confundir riesgo con desconocimiento.
   */
  uncertainCount: number
  protection: { plan: ThreatAssessment[]; totalCost: Euros; remaining: Euros }
  raids: RaidTarget[]
  raidPlan: { plan: RaidTarget[]; totalCost: Euros; remainingCapacity: Euros }
  /**
   * El liston: lo que cuesta el punto mas barato del mercado abierto.
   *
   * Sin esta cifra, "este fichaje te da 12 puntos por 20M" no significa nada.
   * Con ella la pregunta es la correcta: si esos mismos 20M pujando te dan
   * mas puntos, el clausulazo es mala idea aunque sea rentable.
   */
  market: {
    bestCostPerPoint: number | null
    playerName: string | null
    price: Euros | null
    /**
     * Las mejores compras del mercado abierto, de la mas barata por punto a la
     * mas cara. Es la respuesta a "a quien ficho" cuando ningun clausulazo
     * compensa, que con el mercado bien de precio es lo habitual.
     */
    buys: {
      playerId: number
      name: string
      position: string
      price: Euros
      pointsGained: number
      costPerPoint: number
      displaces: string | null
    }[]
  }
  /** Parametros de la valoracion, para poder auditar de donde salen las cifras. */
  valuation: {
    jornadasPlayed: number
    jornadasRemaining: number
    /** Euros de valor de mercado por punto restante. */
    pricePerPoint: number
    /** Puntos por jornada del jugador mediano de cada posicion. */
    positionMean: Record<string, number>
  }
  deadweight: { playerId: number; name: string; value: Euros; reason: string }[]
  /**
   * Once optimo para la proxima jornada. Es exacto, no aproximado: dentro de
   * una formacion las posiciones no compiten entre si, asi que coger los
   * mejores de cada una es optimo, y se enumeran todas las formaciones.
   */
  lineup: {
    formation: string
    expectedPoints: number
    emptySlots: number
    penalty: number
    starters: { playerId: number; name: string; position: string; expectedPoints: number }[]
    /** Cuanto se perderia con el segundo mejor dibujo. */
    costOfNextBest: number
    /** El unico cambio que permite el reglamento, si merece la pena. */
    substitution: { outName: string; inName: string; gain: number; rationale: string } | null
  } | null
  contract: {
    jornadasPlayed: number
    /** Aportacion teorica acumulada por participante, en euros reales. */
    duePerParticipant: number
    potSoFar: number
  }
  warnings: string[]
}

/**
 * Valor de la plantilla que le toco a cada manager al empezar la temporada.
 *
 * Es el unico dato del pasado que no se puede derivar de una foto de hoy, y sin
 * el la reconstruccion de saldos arrastra un sesgo constante igual al error de
 * esa suposicion. Se guarda en data/<temporada>/baseline.json y se rellena una
 * sola vez. Mientras falte, calibrate() lo delata en lugar de disimularlo.
 */
export interface SeasonBaseline {
  initialSquadValueByManager: Record<string, Euros>
}

export function analyze(
  snapshot: LeagueSnapshot,
  transactions: Transaction[],
  warnings: string[],
  now = new Date(),
  baseline?: SeasonBaseline | null,
  progression?: LeagueProgression | null,
  /**
   * Si el feed llego al principio de temporada. Cuando llega, el libro de los
   * rivales esta completo y su saldo deja de ser una estimacion.
   */
  feedComplete = false,
  /** Tus apuntes segun el feed, para la verificacion a ciegas. */
  feedSelfTransactions: Transaction[] = [],
): Diagnosis {
  const config = MLS_LEAGUE

  /**
   * Caja inicial observada en el libro propio.
   *
   * Mister no reparte 50M de saldo: reparte plantilla y acredita el resto en
   * un apunte unico antes de la primera jornada. En la cuenta real fueron
   * 12,47M, o sea una plantilla inicial de 37,53M. El modelo suponia 25M de
   * caja, asi que arrastraba un sesgo de doce millones y medio en el saldo
   * estimado de CADA rival.
   */
  const cajaInicialPropia = observedInitialCash(transactions)
  const plantillaInicialPropia =
    cajaInicialPropia !== null ? config.initialBudget - cajaInicialPropia : undefined

  const initialSquadValue = (id: number): Euros | undefined => {
    const declarado = baseline?.initialSquadValueByManager?.[String(id)]
    if (declarado !== undefined) return declarado
    // Para uno mismo es dato exacto. Para los rivales seria una suposicion, y
    // como suposicion no entra aqui: entra como centro del intervalo, mas
    // abajo, para que siga habiendo intervalo.
    return id === snapshot.selfId ? plantillaInicialPropia : undefined
  }
  const valuation = buildValuationContext(
    snapshot.players.length > 0
      ? snapshot.players
      : snapshot.managers.flatMap((m) => m.squad),
    Math.max(0, snapshot.currentJornada - 1),
    MLS_CONTRACT.totalJornadas,
    progression?.jornadas,
  )

  // Las jornadas disputadas salen de los datos, no del rotulo de la pagina.
  // Si ambos discrepan lo decimos, porque de esa cifra cuelgan todas las
  // medias y todo el calculo del bote.
  const jornadasPlayed = valuation.jornadasPlayed
  const segunLaPagina = Math.max(0, snapshot.currentJornada - 1)

  // Cuantas bonificaciones de jornada se han pagado de verdad. Se cuenta en el
  // libro propio, que es exacto, y vale para los diez: Mister paga a todos a la
  // vez. La progresion lista las jornadas PUNTUADAS, que van por delante.
  const bonosPagados = transactions.filter(
    (t) => t.type === 'bonus' && t.managerId === snapshot.selfId,
  ).length

  // De quien se han visto cobros de quiniela en el feed. Sin esto habria que
  // seguir tratandola como incognita aunque los apuntes ya esten en el libro.
  const quinielaVista = new Set(
    transactions.filter((t) => t.type === 'quiniela').map((t) => t.managerId),
  )

  // Puestos por jornada, indexados por manager.
  const ranksByManager = new Map(
    (progression?.managers ?? []).map((m) => [m.managerId, m.ranks]),
  )
  if (snapshot.players.length > 0 && jornadasPlayed !== segunLaPagina) {
    warnings = [
      ...warnings,
      `la pagina dice jornada ${snapshot.currentJornada} (${segunLaPagina} disputadas) pero los ` +
        `datos de los jugadores dicen ${jornadasPlayed} disputadas; se usan los datos`,
    ]
  }

  const self = snapshot.managers.find((m) => m.id === snapshot.selfId)
  const rivalsRaw = snapshot.managers.filter((m) => m.id !== snapshot.selfId)

  // Transacciones por manager. Hoy solo tenemos el libro propio con certeza;
  // en cuanto se confirme el feed de rivales (docs/INCOGNITAS.md punto 5) esto
  // se llena solo y los intervalos se estrechan mucho.
  const txByManager = new Map<number, Transaction[]>()
  for (const t of transactions) {
    const list = txByManager.get(t.managerId) ?? []
    list.push(t)
    txByManager.set(t.managerId, list)
  }

  const rivals: RivalView[] = rivalsRaw.map((m) => {
    const txs = txByManager.get(m.id) ?? []
    const balance = reconstructBalance(
      {
        managerId: m.id,
        // Con el puesto de cada jornada, la bonificacion deja de ser un rango
        // de 1,0M a 1,5M por jornada y pasa a ser una cifra exacta.
        jornadaRanks: ranksByManager.get(m.id),
        paidBonusCount: bonosPagados > 0 ? bonosPagados : undefined,
        maxClauseSpend: maxClauseSpendForSquad(m.squad),
        minClauseSpend: minClauseSpendForSquad(m.squad),
        initialSquadValue: initialSquadValue(m.id),
        // Sin baseline declarado, se le supone el reparto que se observo en la
        // cuenta propia. Es una suposicion y el intervalo lo dice.
        initialSquadValueHint: plantillaInicialPropia,
        transactions: txs,
        // Con /ajax/feed paginado hasta el principio de temporada, el libro
        // rival deja de estar cortado: trae traspasos, quiniela, cambios de
        // clausula y pagos. Solo se declara completo si el servidor confirmo
        // que no quedaban mas paginas.
        historyComplete: feedComplete,
        quinielaObserved: quinielaVista.has(m.id),
        teamValue: m.teamValue,
        averageLineupValue: Math.round(m.teamValue * 0.6),
        // Si ha puntuado es que no arranco la jornada en negativo, porque
        // Mister da cero puntos a quien empieza en rojo. Es una cota
        // debil (habla del ultimo arranque de jornada, no de ahora mismo)
        // pero descarta el escenario de deuda profunda.
        scoredJornadas: m.points > 0 ? [jornadasPlayed] : [],
      },
      config,
    )
    return {
      managerId: m.id,
      name: m.name,
      points: m.points,
      teamValue: m.teamValue,
      balance,
      threatCapacity: spendingCapacity(balance, m.teamValue, config, 'worst'),
      squadSize: m.squad.length,
    }
  })

  // Calibracion: reconstruimos TU saldo y lo comparamos con el real. Es la
  // unica forma honesta de saber si el metodo aplicado a los rivales vale.
  // La auditoria va primero: si la suma de movimientos no cuadra consigo misma,
  // no tiene sentido confiar en ella para estimar los saldos rivales.
  const ownTxsAll = self ? (txByManager.get(self.id) ?? []) : []
  const audit: HistoryAudit | null = ownTxsAll.length > 0 ? auditHistory(ownTxsAll) : null

  let calibration: Calibration | null = null
  if (self && self.balance !== undefined) {
    const ownTxs = txByManager.get(self.id) ?? []
    if (ownTxs.length > 0) {
      const reconstructed = reconstructBalance(
        {
          managerId: self.id,
          // El propio libro dice cual era el saldo antes del primer movimiento,
          // asi que no hace falta suponer el valor de la plantilla inicial.
          initialSquadValue:
            audit?.derivedInitialCash !== null && audit?.derivedInitialCash !== undefined
              ? config.initialBudget - audit.derivedInitialCash
              : initialSquadValue(self.id),
          transactions: ownTxs,
          historyComplete: true,
          teamValue: self.teamValue,
          averageLineupValue: Math.round(self.teamValue * 0.6),
        },
        config,
      )
      calibration = calibrate(reconstructed, self.balance)
    }
  }

  // --- La verificacion que de verdad prueba el metodo ---
  //
  // La calibracion de arriba reconstruye tu saldo con TU libro, que trae el
  // saldo resultante de cada apunte. Eso prueba que la aritmetica cuadra, pero
  // no prueba nada del metodo que se aplica a los rivales, porque de ellos no
  // se tiene ese libro.
  //
  // Esta reconstruye tu saldo usando SOLO lo que se ve de un rival: el feed,
  // la regla del reparto y los puestos por jornada. Si coincide con el saldo
  // real, el metodo esta demostrado. Si no, la diferencia dice exactamente
  // cuanto falta y por donde.
  let blindCalibration: Calibration | null = null
  if (self && self.balance !== undefined && feedSelfTransactions.length > 0) {
    const aCiegas = reconstructBalance(
      {
        managerId: self.id,
        jornadaRanks: ranksByManager.get(self.id),
        paidBonusCount: bonosPagados > 0 ? bonosPagados : undefined,
        maxClauseSpend: maxClauseSpendForSquad(self.squad),
        minClauseSpend: minClauseSpendForSquad(self.squad),
        transactions: feedSelfTransactions,
        historyComplete: feedComplete,
        quinielaObserved: feedSelfTransactions.some((t) => t.type === 'quiniela'),
        teamValue: self.teamValue,
        averageLineupValue: Math.round(self.teamValue * 0.6),
        scoredJornadas: self.points > 0 ? [jornadasPlayed] : [],
      },
      config,
    )
    blindCalibration = calibrate(aCiegas, self.balance)
  }

  const rivalCapacities: RivalCapacity[] = rivalsRaw.map((m) => {
    const view = rivals.find((r) => r.managerId === m.id)!
    return {
      managerId: m.id,
      name: m.name,
      // Cota superior: lo maximo que podria gastar. Mide la amenaza.
      capacity: view.threatCapacity,
      // Cota inferior: lo que con seguridad puede gastar. Separa la amenaza
      // real de la mera falta de informacion.
      capacityLow: spendingCapacity(view.balance, m.teamValue, config, 'best'),
      // Su plantilla es lo que permite saber si un jugador tuyo le SIRVE, no
      // solo si puede pagarlo. Sin esto, cualquiera con saldo era amenaza.
      squad: m.squad,
    }
  })

  const threats = self ? assessSquad(self.squad, rivalCapacities, valuation, config, now) : []

  const ownBalance = self?.balance ?? 0
  const ownMaxSpend = self?.maxDebt ?? 0

  // El presupuesto de proteccion no puede comerse todo el saldo: hay que
  // dejar margen para fichar y, sobre todo, para no llegar en negativo a la
  // jornada, que significaria cero puntos.
  const protectionBudget = Math.max(0, Math.round(ownBalance * 0.4))
  const protection = planProtection(threats, protectionBudget)

  // Lo que cuesta el punto mas barato del mercado abierto. Es el liston con el
  // que se juzga cualquier clausulazo: si esos euros compran puntos mas
  // baratos pujando, robar no compensa aunque el robo sea rentable en si.
  const playerById = new Map(snapshot.players.map((p) => [p.id, p]))
  const ofertas = snapshot.market
    .map((e) => ({ player: playerById.get(e.playerId), price: e.price }))
    .filter((o): o is { player: Player; price: number } => o.player !== undefined && o.price > 0)
  const compras = self
    ? rankMarketBuys(ofertas, self.squad, valuation, config, ownMaxSpend)
    : []
  const benchmark = compras[0]
    ? { costPerPoint: compras[0].costPerPoint, player: compras[0].player, price: compras[0].price }
    : { costPerPoint: Number.POSITIVE_INFINITY }

  const raidCtx = {
    squad: self?.squad ?? [],
    marketCostPerPoint: benchmark.costPerPoint,
    capacity: ownMaxSpend,
    squadSize: self?.squad.length ?? 0,
    clauseSigningsToday: 0,
    now,
  }
  const raids = findRaidTargets(
    rivalsRaw.map((m) => ({ managerId: m.id, name: m.name, squad: m.squad })),
    valuation,
    raidCtx,
    config,
  )
  const raidPlan = planRaids(raids, raidCtx, config)

  const deadweight = self
    ? findDeadweight(self.squad, valuation).map((d) => ({
        playerId: d.player.id,
        name: d.player.name,
        value: d.player.value,
        reason: d.reason,
      }))
    : []

  if (!baseline && plantillaInicialPropia === undefined) {
    warnings = [
      ...warnings,
      'falta data/<temporada>/baseline.json con el valor de la plantilla inicial de cada ' +
        'manager, y el libro propio tampoco trae el apunte de saldo inicial: sin ninguna de las ' +
        'dos cosas, los saldos estimados arrastran un sesgo constante (lo cuantifica la ' +
        'calibracion)',
    ]
  } else if (!baseline) {
    warnings = [
      ...warnings,
      `sin baseline.json, a cada rival se le supone la plantilla inicial que se observo en la ` +
        `cuenta propia (${Math.round((plantillaInicialPropia ?? 0) / 100_000) / 10}M) con un ` +
        'margen del 20%; es una suposicion razonable porque el reparto es el mismo para todos, ' +
        'pero sigue siendo una suposicion',
    ]
  }

  // Once optimo. Solo tiene sentido con plantilla propia identificada.
  let lineup: Diagnosis['lineup'] = null
  if (self && self.squad.length > 0) {
    const { best, alternatives } = optimizeLineup(self.squad, valuation, config)
    const sub = bestSubstitution(best, valuation)
    lineup = {
      formation: best.formation.name,
      expectedPoints: Math.round(best.expectedPoints * 10) / 10,
      emptySlots: best.emptySlots,
      penalty: best.penalty,
      starters: best.slots
        .filter((sl) => sl.player !== null)
        .map((sl) => ({
          playerId: sl.player!.id,
          name: sl.player!.name,
          position: sl.position,
          expectedPoints: Math.round(sl.expectedPoints * 10) / 10,
        })),
      costOfNextBest:
        alternatives.length > 0
          ? Math.round((best.expectedPoints - alternatives[0]!.expectedPoints) * 10) / 10
          : 0,
      substitution: sub
        ? {
            outName: sub.out.name,
            inName: sub.in.name,
            gain: Math.round(sub.gain * 10) / 10,
            rationale: sub.rationale,
          }
        : null,
    }
  }

  const standings = [...snapshot.managers].sort((a, b) => b.points - a.points)
  const rank = self ? standings.findIndex((m) => m.id === self.id) + 1 : 0
  const leaderPoints = standings[0]?.points ?? 0

  return {
    generatedAt: now.toISOString(),
    seasonId: snapshot.seasonId,
    currentJornada: snapshot.currentJornada,
    self: {
      managerId: self?.id ?? 0,
      name: self?.name ?? 'desconocido',
      points: self?.points ?? 0,
      teamValue: self?.teamValue ?? 0,
      balance: self?.balance ?? null,
      maxSpend: self?.maxDebt ?? null,
      rank,
      pointsToLeader: leaderPoints - (self?.points ?? 0),
    },
    rivals: rivals.sort((a, b) => b.threatCapacity - a.threatCapacity),
    calibration,
    blindCalibration,
    historyAudit: audit
      ? {
          checked: audit.checked,
          mismatches: audit.mismatches.length,
          derivedInitialCash: audit.derivedInitialCash,
          worst:
            audit.mismatches.length > 0
              ? (() => {
                  const w = [...audit.mismatches].sort(
                    (a, b) => Math.abs(b.diff) - Math.abs(a.diff),
                  )[0]!
                  return { date: w.date, type: w.type, playerName: w.playerName, diff: w.diff }
                })()
              : null,
        }
      : null,
    threats: threats.filter((t) => t.risk !== 'ninguno' || t.advice.action === 'cebo'),
    uncertainCount: threats.filter((t) => t.advice.action === 'incierto').length,
    protection,
    raids: raids.filter((r) => r.viable).slice(0, 15),
    raidPlan,
    market: {
      bestCostPerPoint: Number.isFinite(benchmark.costPerPoint) ? benchmark.costPerPoint : null,
      playerName: 'player' in benchmark ? (benchmark.player?.name ?? null) : null,
      price: 'price' in benchmark ? (benchmark.price ?? null) : null,
      buys: compras.slice(0, 8).map((c) => ({
        playerId: c.player.id,
        name: c.player.name,
        position: c.player.position,
        price: c.price,
        pointsGained: Math.round(c.gain.remaining * 10) / 10,
        costPerPoint: Math.round(c.costPerPoint),
        displaces: c.gain.displaces?.name ?? null,
      })),
    },
    valuation: {
      jornadasPlayed: valuation.jornadasPlayed,
      jornadasRemaining: valuation.jornadasRemaining,
      pricePerPoint: Math.round(valuation.pricePerPoint),
      positionMean: Object.fromEntries(
        Object.entries(valuation.positionMean).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
    },
    deadweight,
    lineup,
    contract: {
      jornadasPlayed,
      duePerParticipant: jornadasPlayed * MLS_CONTRACT.feePerJornada,
      potSoFar: jornadasPlayed * MLS_CONTRACT.feePerJornada * MLS_CONTRACT.participants,
    },
    warnings,
  }
}
