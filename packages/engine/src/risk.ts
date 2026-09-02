import type { Euros, OwnedPlayer, LeagueConfig } from '@mls/core'
import {
  clauseBase, defaultClause, cheapestTierAbove, tierCost, clauseForTier,
  isShielded, CLAUSE_TIER_LABEL, type ClauseTier,
} from './clauses.ts'
import { sportingValue, type ValuationContext } from './valuation.ts'

/**
 * A quien subirle la clausula.
 *
 * La intuicion habitual es proteger a los mejores. Es incorrecta. Lo que hay
 * que proteger es a los jugadores cuya clausula esta POR DEBAJO de lo que
 * valen deportivamente, porque son los unicos que a un rival le compensa
 * robar. Un jugador carisimo con una clausula altisima no corre peligro, y
 * gastar en el es tirar el dinero.
 *
 * El corolario incomodo, y muy util: si la clausula de un jugador SUPERA su
 * valor deportivo, que te lo roben es un buen negocio. Cobras mas de lo que te
 * aporta y el rival se queda con un activo caro. Esos jugadores son cebo y hay
 * que dejarlos deliberadamente sin proteger.
 *
 * Como el tipo de cambio es plano (0,40 EUR por cada euro de proteccion), no
 * hay que elegir "tramo bueno": se elige el tramo MAS BARATO que deja la
 * clausula fuera del alcance del rival mas rico. Ni un euro mas.
 */

export interface RivalCapacity {
  managerId: number
  name: string
  /** Saldo estimado mas el margen de deuda, en su escenario mas favorable. */
  capacity: Euros
}

export type RiskLevel = 'ninguno' | 'bajo' | 'medio' | 'alto'

export interface ProtectionAdvice {
  action: 'nada' | 'subir' | 'imposible' | 'cebo'
  tier?: ClauseTier | undefined
  cost?: Euros | undefined
  newClause?: Euros | undefined
  rationale: string
}

export interface ThreatAssessment {
  player: OwnedPlayer
  base: Euros
  clause: Euros
  sportingValue: Euros
  /** Beneficio que sacaria un rival al robarlo. Si es <= 0, nadie racional lo hace. */
  raidProfit: Euros
  /** Rivales con capacidad para pagar la clausula hoy. */
  threats: RivalCapacity[]
  shielded: boolean
  risk: RiskLevel
  /** Perdida esperada si no se hace nada. */
  expectedLoss: Euros
  advice: ProtectionAdvice
}

function riskLevel(raidProfit: Euros, threatCount: number, shielded: boolean): RiskLevel {
  if (shielded || threatCount === 0 || raidProfit <= 0) return 'ninguno'
  if (threatCount >= 3 && raidProfit > 0) return 'alto'
  if (threatCount >= 1 && raidProfit > 0) return 'medio'
  return 'bajo'
}

/**
 * Probabilidad heuristica de que roben a un jugador en la ventana proxima.
 * No pretende ser una probabilidad calibrada: ordena decisiones. Crece con el
 * numero de rivales que pueden pagar y con lo goloso que resulta el robo.
 */
function raidProbability(raidProfit: Euros, clause: Euros, threatCount: number): number {
  if (threatCount === 0 || raidProfit <= 0 || clause <= 0) return 0
  const bargain = Math.min(1, raidProfit / clause)
  const pressure = 1 - Math.pow(0.55, threatCount)
  return Math.min(0.95, bargain * pressure)
}

export function assessPlayerThreat(
  player: OwnedPlayer,
  rivals: RivalCapacity[],
  ctx: ValuationContext,
  config: LeagueConfig,
  now: Date,
): ThreatAssessment {
  const base = clauseBase(player)
  const clause = player.clause ?? defaultClause(base, player.value)
  const sv = sportingValue(player, ctx)
  const raidProfit = sv - clause
  const shielded = isShielded(player, now)

  const threats = rivals
    .filter((r) => r.capacity >= clause)
    .sort((a, b) => b.capacity - a.capacity)

  const risk = riskLevel(raidProfit, threats.length, shielded)
  const p = shielded ? 0 : raidProbability(raidProfit, clause, threats.length)
  const expectedLoss = Math.round(p * Math.max(0, raidProfit))

  return {
    player,
    base,
    clause,
    sportingValue: sv,
    raidProfit,
    threats,
    shielded,
    risk,
    expectedLoss,
    advice: adviseProtection({ player, base, clause, raidProfit, threats, shielded, expectedLoss, config }),
  }
}

function adviseProtection(args: {
  player: OwnedPlayer
  base: Euros
  clause: Euros
  raidProfit: Euros
  threats: RivalCapacity[]
  shielded: boolean
  expectedLoss: Euros
  config: LeagueConfig
}): ProtectionAdvice {
  const { player, base, raidProfit, threats, shielded, expectedLoss } = args

  if (raidProfit <= 0) {
    return {
      action: 'cebo',
      rationale:
        'Su clausula ya supera lo que va a rendir. Si te lo roban sales ganando: ' +
        'cobras mas de lo que aporta. Dejalo sin proteger a proposito.',
    }
  }

  if (shielded) {
    return {
      action: 'nada',
      rationale: `Blindado por fichaje reciente (${args.config.clauseShieldDays} dias). Nadie puede tocarlo todavia.`,
    }
  }

  if (threats.length === 0) {
    return {
      action: 'nada',
      rationale: 'Ningun rival tiene hoy capacidad para pagar su clausula.',
    }
  }

  const richest = threats[0]!.capacity
  const tier = cheapestTierAbove(base, richest, player.value)

  if (tier === null) {
    return {
      action: 'imposible',
      rationale:
        `Ni el tramo maximo (3x) lo pone fuera del alcance de ${threats[0]!.name}. ` +
        'Gastar en protegerlo no sirve de nada: o lo vendes tu, o asumes el robo y cobras la clausula.',
    }
  }

  if (tier === 0) {
    return { action: 'nada', rationale: 'La clausula por defecto ya lo deja fuera de su alcance.' }
  }

  const cost = tierCost(base, tier)
  if (cost > expectedLoss) {
    return {
      action: 'nada',
      tier,
      cost,
      rationale:
        `Protegerlo cuesta mas que la perdida esperada por no hacerlo. ` +
        'Es dinero mejor empleado en otro sitio.',
    }
  }

  return {
    action: 'subir',
    tier,
    cost,
    newClause: clauseForTier(base, tier, player.value),
    rationale:
      `${threats.length} rival(es) pueden pagarle la clausula y les sale a cuenta. ` +
      `El tramo ${CLAUSE_TIER_LABEL[tier]} es el mas barato que lo deja fuera del alcance del mas rico.`,
  }
}

/** Evalua toda tu plantilla y ordena por perdida esperada. */
export function assessSquad(
  squad: OwnedPlayer[],
  rivals: RivalCapacity[],
  ctx: ValuationContext,
  config: LeagueConfig,
  now: Date,
): ThreatAssessment[] {
  return squad
    .map((p) => assessPlayerThreat(p, rivals, ctx, config, now))
    .sort((a, b) => b.expectedLoss - a.expectedLoss)
}

/**
 * Reparte un presupuesto de proteccion entre los jugadores que mas lo
 * merecen. Como el tipo de cambio es identico para todos, el criterio correcto
 * es simplemente atender primero la mayor perdida esperada evitada por euro.
 */
export function planProtection(
  assessments: ThreatAssessment[],
  budget: Euros,
): { plan: ThreatAssessment[]; totalCost: Euros; remaining: Euros } {
  const candidates = assessments
    .filter((a) => a.advice.action === 'subir' && (a.advice.cost ?? 0) > 0)
    .sort((a, b) => b.expectedLoss / (b.advice.cost ?? 1) - a.expectedLoss / (a.advice.cost ?? 1))

  const plan: ThreatAssessment[] = []
  let spent = 0
  for (const c of candidates) {
    const cost = c.advice.cost ?? 0
    if (spent + cost <= budget) {
      plan.push(c)
      spent += cost
    }
  }
  return { plan, totalCost: spent, remaining: budget - spent }
}
