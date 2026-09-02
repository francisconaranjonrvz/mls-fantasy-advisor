import type { Euros, OwnedPlayer, LeagueConfig } from '@mls/core'
import { clauseBase, defaultClause, isShielded } from './clauses.js'
import { sportingValue, valueRatio, type ValuationContext } from './valuation.js'

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
  sportingValue: Euros
  /** Beneficio deportivo neto del robo, en euros. */
  profit: Euros
  /** Retorno por euro invertido. Ordena mejor que el beneficio absoluto. */
  roi: number
  /** Clausula que tendria el jugador ya en tu equipo, tras el robo. */
  clauseAfterRaid: Euros
  blockers: RaidBlocker[]
  viable: boolean
}

export interface RaidContext {
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
  const profit = sv - clause

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
    profit,
    roi: clause > 0 ? profit / clause : 0,
    // Tras el robo, el precio pagado pasa a ser el precio de compra.
    clauseAfterRaid: Math.round(clause * 1.5),
    blockers,
    viable: blockers.length === 0 && profit > 0,
  }
}

/**
 * Recorre las plantillas rivales y ordena los objetivos por retorno.
 *
 * Se ordena por ROI y no por beneficio absoluto porque el saldo es el recurso
 * escaso: con 20M prefieres dos robos que rinden un 40% cada uno que uno solo
 * que rinde un 25%.
 */
export function findRaidTargets(
  rivalSquads: { managerId: number; name: string; squad: OwnedPlayer[] }[],
  valuation: ValuationContext,
  raidCtx: RaidContext,
  config: LeagueConfig,
): RaidTarget[] {
  const targets: RaidTarget[] = []
  for (const rival of rivalSquads) {
    for (const player of rival.squad) {
      targets.push(evaluateRaid(player, rival.name, valuation, raidCtx, config))
    }
  }
  return targets.sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1
    return b.roi - a.roi
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
