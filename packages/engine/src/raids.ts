import type { Euros, OwnedPlayer, LeagueConfig } from '@mls/core'
import { clauseBase, defaultClause, isShielded } from './clauses.ts'
import { sportingValue, valueRatio, type ValuationContext } from './valuation.ts'
import { marginalGain, costPerPoint, type MarginalGain } from './marginal.ts'
import { optimizeLineup, type LineupPlan } from './lineup.ts'

/**
 * Busqueda de clausulazos.
 *
 * En una liga de 10 con solo 20 huecos de mercado que ademas rotan en
 * proporcion a lo que se compra, el mercado abierto casi nunca ofrece nada
 * bueno. El canal real para mejorar la plantilla es pagar la clausula de un
 * jugador de otro. Por eso este modulo importa tanto como el de proteccion:
 * son las dos caras de la misma moneda.
 *
 * Un robo compensa cuando el jugador rinde mas de lo que cuesta su clausula.
 * Y tiene una ventaja que se suele pasar por alto: al ficharlo por clausula,
 * el precio pagado pasa a ser su nuevo precio de compra, asi que su clausula
 * se recalcula sobre esa cifra inflada y ademas queda blindado unos dias. El
 * robo se autoprotege.
 */

export interface RaidBlocker {
  reason: 'blindado' | 'ventana_jornada' | 'sin_saldo' | 'plantilla_llena' | 'limite_diario'
  detail: string
}

export interface RaidTarget {
  player: OwnedPlayer
  ownerId: number
  ownerName: string
  clause: Euros
  /** Precio justo del jugador. Sirve de referencia, no de criterio. */
  sportingValue: Euros
  /**
   * Lo que el fichaje mejora TU once. Es el criterio de verdad: un jugador
   * excelente en una posicion que ya tienes cubierta no te aporta nada.
   */
  gain: MarginalGain
  /** Euros por cada punto que suma al once. Mas bajo es mejor. */
  costPerPoint: number
  /** Beneficio deportivo neto del robo, en euros. */
  profit: Euros
  /** Retorno por euro invertido. Ordena mejor que el beneficio absoluto. */
  roi: number
  /** Si el punto sale mas barato aqui que en la mejor oferta del mercado. */
  beatsMarket: boolean
  /** Clausula que tendria el jugador ya en tu equipo, tras el robo. */
  clauseAfterRaid: Euros
  blockers: RaidBlocker[]
  viable: boolean
}

export interface RaidContext {
  /** Tu plantilla. Sin ella no se puede saber a quien desplaza un fichaje. */
  squad: OwnedPlayer[]
  /**
   * Coste por punto de la mejor oferta del mercado abierto. Es el listón: un
   * clausulazo que sale mas caro que comprar en el mercado no compensa aunque
   * su beneficio sea positivo. Infinito si el mercado no ofrece nada.
   */
  marketCostPerPoint: number
  /** Once optimo actual, para no recalcularlo por cada candidato. */
  baseline?: LineupPlan | undefined
  capacity: Euros
  squadSize: number
  /** Clausulas ya pagadas hoy, para respetar el limite diario. */
  clauseSigningsToday: number
  /** Cuando arranca la proxima jornada, para la ventana de bloqueo. */
  nextJornadaStart?: Date | undefined
  now: Date
}

/** La ventana previa a la jornada en que Mister bloquea las clausulas. */
export function isClauseWindowClosed(ctx: RaidContext, config: LeagueConfig): boolean {
  if (!ctx.nextJornadaStart) return false
  const hoursLeft = (ctx.nextJornadaStart.getTime() - ctx.now.getTime()) / 3_600_000
  return hoursLeft >= 0 && hoursLeft <= config.preJornadaClauseBlockHours
}

export function evaluateRaid(
  player: OwnedPlayer,
  ownerName: string,
  valuation: ValuationContext,
  raidCtx: RaidContext,
  config: LeagueConfig,
): RaidTarget {
  const base = clauseBase(player)
  const clause = player.clause ?? defaultClause(base, player.value)
  const sv = sportingValue(player, valuation)

  const gain = marginalGain(player, raidCtx.squad, valuation, config, raidCtx.baseline)
  const cpp = costPerPoint(clause, gain)
  // El beneficio se mide sobre lo que el fichaje aporta a TU once, no sobre
  // los puntos del jugador. Es la diferencia entre "es bueno" y "me sirve".
  const profit = Math.round(gain.remaining * valuation.pricePerPoint) - clause
  const beatsMarket = cpp < raidCtx.marketCostPerPoint

  const blockers: RaidBlocker[] = []

  if (isShielded(player, raidCtx.now)) {
    blockers.push({
      reason: 'blindado',
      detail: `Blindado hasta ${player.shieldedUntil}. Fichado hace menos de ${config.clauseShieldDays} dias.`,
    })
  }
  if (isClauseWindowClosed(raidCtx, config)) {
    blockers.push({
      reason: 'ventana_jornada',
      detail: `Las clausulas estan bloqueadas en las ${config.preJornadaClauseBlockHours}h previas a la jornada.`,
    })
  }
  if (clause > raidCtx.capacity) {
    blockers.push({
      reason: 'sin_saldo',
      detail: `Cuesta ${clause} y tu capacidad maxima es ${raidCtx.capacity}.`,
    })
  }
  if (raidCtx.squadSize >= config.maxSquadSize) {
    blockers.push({
      reason: 'plantilla_llena',
      detail: `Ya tienes ${raidCtx.squadSize} jugadores, el tope es ${config.maxSquadSize}. Vende antes.`,
    })
  }
  if (raidCtx.clauseSigningsToday >= config.maxClauseSigningsPerDay) {
    blockers.push({
      reason: 'limite_diario',
      detail: `Limite de ${config.maxClauseSigningsPerDay} fichajes por clausula al dia ya agotado.`,
    })
  }

  return {
    player,
    ownerId: player.ownerId,
    ownerName,
    clause,
    sportingValue: sv,
    gain,
    costPerPoint: cpp,
    profit,
    roi: clause > 0 ? profit / clause : 0,
    beatsMarket,
    // Tras el robo, el precio pagado pasa a ser el precio de compra.
    clauseAfterRaid: Math.round(clause * 1.5),
    blockers,
    // Que aporte puntos no basta: tienen que salir mas baratos que en el
    // mercado abierto, que es la alternativa real para ese mismo dinero.
    viable: blockers.length === 0 && gain.remaining > 0 && profit > 0 && beatsMarket,
  }
}

/**
 * Recorre las plantillas rivales y ordena los objetivos por coste del punto.
 *
 * Se ordena por coste por punto y no por beneficio absoluto porque el saldo es
 * el recurso escaso: con 20M prefieres dos fichajes que te den puntos a 300k
 * que uno solo que te los de a 800k.
 */
export function findRaidTargets(
  rivalSquads: { managerId: number; name: string; squad: OwnedPlayer[] }[],
  valuation: ValuationContext,
  raidCtx: RaidContext,
  config: LeagueConfig,
): RaidTarget[] {
  // El once de partida es el mismo para todos los candidatos, asi que se
  // calcula una vez: son dos centenares de jugadores rivales.
  const ctx: RaidContext = {
    ...raidCtx,
    baseline: raidCtx.baseline ?? optimizeLineup(raidCtx.squad, valuation, config).best,
  }

  const targets: RaidTarget[] = []
  for (const rival of rivalSquads) {
    for (const player of rival.squad) {
      targets.push(evaluateRaid(player, rival.name, valuation, ctx, config))
    }
  }
  return targets.sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1
    return a.costPerPoint - b.costPerPoint
  })
}

/**
 * Selecciona los robos a ejecutar respetando saldo, tope de plantilla y el
 * limite de fichajes por clausula al dia.
 */
export function planRaids(
  targets: RaidTarget[],
  raidCtx: RaidContext,
  config: LeagueConfig,
): { plan: RaidTarget[]; totalCost: Euros; remainingCapacity: Euros } {
  const plan: RaidTarget[] = []
  let capacity = raidCtx.capacity
  let squad = raidCtx.squadSize
  let signings = raidCtx.clauseSigningsToday

  for (const t of targets) {
    if (!t.viable) continue
    if (signings >= config.maxClauseSigningsPerDay) break
    if (squad >= config.maxSquadSize) break
    if (t.clause > capacity) continue

    plan.push(t)
    capacity -= t.clause
    squad += 1
    signings += 1
  }

  return {
    plan,
    totalCost: raidCtx.capacity - capacity,
    remainingCapacity: capacity,
  }
}

/**
 * Jugadores de tu plantilla que ya no aportan y conviene vender: los que se
 * fueron de LaLiga puntuan cero para siempre, y los que rinden muy por debajo
 * de su precio son capital inmovilizado.
 */
export function findDeadweight(
  squad: OwnedPlayer[],
  valuation: ValuationContext,
  ratioThreshold = 0.5,
): { player: OwnedPlayer; reason: string }[] {
  const out: { player: OwnedPlayer; reason: string }[] = []
  for (const p of squad) {
    if (!p.hasTeam) {
      out.push({ player: p, reason: 'Ya no juega en LaLiga: puntuara cero el resto de temporada.' })
      continue
    }
    const ratio = valueRatio(p, valuation)
    if (ratio < ratioThreshold) {
      out.push({
        player: p,
        reason: `Rinde un ${Math.round(ratio * 100)}% de lo que vale. Capital inmovilizado.`,
      })
    }
  }
  return out.sort((a, b) => b.player.value - a.player.value)
}
