import {
  MLS_LEAGUE, MLS_CONTRACT,
  type LeagueSnapshot, type Transaction, type Euros, type Player,
} from '@mls/core'
import {
  buildValuationContext, reconstructBalance, exactBalance, spendingCapacity,
  calibrate, assessSquad, planProtection, findRaidTargets, planRaids, findDeadweight,
  optimizeLineup, bestSubstitution, auditHistory, marketBenchmark,
  type BalanceEstimate, type ThreatAssessment, type RaidTarget, type RivalCapacity,
  type Calibration, type LineupPlan, type SubstitutionAdvice, type HistoryAudit,
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
  /** Contraste de la reconstruccion contra tu saldo real. */
  calibration: Calibration | null
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
): Diagnosis {
  const initialSquadValue = (id: number): Euros | undefined =>
    baseline?.initialSquadValueByManager?.[String(id)]
  const config = MLS_LEAGUE
  const valuation = buildValuationContext(
    snapshot.players.length > 0
      ? snapshot.players
      : snapshot.managers.flatMap((m) => m.squad),
    Math.max(0, snapshot.currentJornada - 1),
    MLS_CONTRACT.totalJornadas,
  )

  // Las jornadas disputadas salen de los datos, no del rotulo de la pagina.
  // Si ambos discrepan lo decimos, porque de esa cifra cuelgan todas las
  // medias y todo el calculo del bote.
  const jornadasPlayed = valuation.jornadasPlayed
  const segunLaPagina = Math.max(0, snapshot.currentJornada - 1)
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
        initialSquadValue: initialSquadValue(m.id),
        transactions: txs,
        // El feed publica los traspasos pero no las bonificaciones ni las
        // modificaciones de clausula, asi que el historial rival nunca es
        // completo. Se marca como tal para que el intervalo lo refleje en vez
        // de fingir precision.
        historyComplete: false,
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
  const benchmark = self
    ? marketBenchmark(ofertas, self.squad, valuation, config, ownMaxSpend)
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

  if (!baseline) {
    warnings = [
      ...warnings,
      'falta data/<temporada>/baseline.json con el valor de la plantilla inicial de cada ' +
        'manager: sin el, los saldos estimados arrastran un sesgo constante (lo cuantifica ' +
        'la calibracion)',
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
