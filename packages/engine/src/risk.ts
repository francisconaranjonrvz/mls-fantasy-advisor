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
  /** Capacidad en su escenario mas rico. Es la cota superior de la amenaza. */
  capacity: Euros
  /**
   * Capacidad en su escenario mas pobre. La diferencia entre ambas es lo que
   * NO sabemos de ese rival.
   *
   * Distinguirlas importa mucho en la practica. Si la cota inferior ya supera
   * la clausula, el rival puede pagarla con seguridad y la amenaza es real. Si
   * solo la supera la cota superior, puede que pueda y puede que no: eso no es
   * una amenaza, es falta de informacion, y tratarlo como amenaza lleva a
   * gastar en proteger a media plantilla.
   */
  capacityLow?: Euros | undefined
}

export type RiskLevel = 'ninguno' | 'bajo' | 'medio' | 'alto'

export interface ProtectionAdvice {
  action: 'nada' | 'subir' | 'imposible' | 'cebo' | 'incierto'
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
  /** Rivales que con seguridad pueden pagar la clausula. */
  threats: RivalCapacity[]
  /** Rivales que quiza puedan: no se descarta, pero no esta confirmado. */
  possibleThreats: RivalCapacity[]
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

  // Amenaza CIERTA: incluso en su escenario mas pobre el rival puede pagar.
  // Amenaza POSIBLE: solo llega en su escenario mas rico, asi que no sabemos.
  const canReach = rivals.filter((r) => r.capacity >= clause)
  const threats = canReach
    .filter((r) => (r.capacityLow ?? r.capacity) >= clause)
    .sort((a, b) => b.capacity - a.capacity)
  const possibleThreats = canReach
    .filter((r) => (r.capacityLow ?? r.capacity) < clause)
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
    possibleThreats,
    shielded,
    risk,
    expectedLoss,
    advice: adviseProtection({
      player, base, clause, sportingValue: sv, raidProfit, threats, possibleThreats,
      shielded, expectedLoss, config,
    }),
  }
}

function adviseProtection(args: {
  player: OwnedPlayer
  base: Euros
  clause: Euros
  sportingValue: Euros
  raidProfit: Euros
  threats: RivalCapacity[]
  possibleThreats: RivalCapacity[]
  shielded: boolean
  expectedLoss: Euros
  config: LeagueConfig
}): ProtectionAdvice {
  const { player, base, sportingValue: sv, raidProfit, threats, possibleThreats, shielded, expectedLoss } = args

  if (raidProfit <= 0) {
    return {
      action: 'cebo',
      rationale:
        'Su clausula ya supera lo que va a rendir. Si te lo roban sales ganando: cobras mas de ' +
        'lo que aporta. Dejalo sin proteger a proposito.',
    }
  }

  if (shielded) {
    return {
      action: 'nada',
      rationale: `Blindado por fichaje reciente (${args.config.clauseShieldDays} dias). Nadie puede tocarlo todavia.`,
    }
  }

  if (threats.length === 0) {
    if (possibleThreats.length > 0) {
      return {
        action: 'incierto',
        rationale:
          `No consta que nadie pueda pagar su clausula, pero ${possibleThreats.length} rival(es) ` +
          'podrian llegar en su escenario mas favorable. La incertidumbre viene de que Mister ' +
          'oculta el saldo ajeno; se estrecha en cuanto la ingesta capture el feed de movimientos ' +
          'de los rivales (docs/INCOGNITAS.md punto 5).',
      }
    }
    return { action: 'nada', rationale: 'Ningun rival tiene hoy capacidad para pagar su clausula.' }
  }

  // Aqui esta la clave de todo el modulo.
  //
  // Lo intuitivo es intentar poner la clausula por encima de lo que el rival
  // PUEDE pagar. En esta liga eso casi nunca funciona: el margen de deuda del
  // 25% sobre un equipo de 120M ya da 30M de capacidad a cualquiera, aunque
  // este a cero de saldo. Perseguir esa cifra sale carisimo o es imposible.
  //
  // Lo que si funciona es quitarle el INCENTIVO. Nadie roba a perdida, asi que
  // basta con dejar la clausula por encima de lo que el jugador va a rendir.
  // Suele costar un tramo y es casi siempre alcanzable.
  const tierNoIncentive = cheapestTierAbove(base, sv, player.value)

  if (tierNoIncentive !== null) {
    if (tierNoIncentive === 0) {
      return {
        action: 'nada',
        rationale: 'Su clausula por defecto ya supera lo que va a rendir: robarlo seria mal negocio.',
      }
    }
    const cost = tierCost(base, tierNoIncentive)
    if (cost > expectedLoss) {
      return {
        action: 'nada',
        tier: tierNoIncentive,
        cost,
        rationale:
          'Quitarle el incentivo al rival cuesta mas que la perdida esperada por no hacer nada. ' +
          'Ese dinero rinde mas en otro sitio.',
      }
    }
    return {
      action: 'subir',
      tier: tierNoIncentive,
      cost,
      newClause: clauseForTier(base, tierNoIncentive, player.value),
      rationale:
        `Subiendo al tramo ${CLAUSE_TIER_LABEL[tierNoIncentive]} la clausula pasa a superar lo que ` +
        'el jugador va a rendir, asi que robarlo deja de salirle a cuenta a nadie. No hace falta ' +
        'ponerlo fuera del alcance de su saldo, que ademas seria mucho mas caro.',
    }
  }

  // Ni el tramo maximo elimina el incentivo. Ultimo recurso: ponerlo fuera del
  // alcance del rival mas rico, que es lo caro.
  const richest = threats[0]!.capacity
  const tierOutOfReach = cheapestTierAbove(base, richest, player.value)

  if (tierOutOfReach !== null && tierOutOfReach > 0) {
    const cost = tierCost(base, tierOutOfReach)
    if (cost <= expectedLoss) {
      return {
        action: 'subir',
        tier: tierOutOfReach,
        cost,
        newClause: clauseForTier(base, tierOutOfReach, player.value),
        rationale:
          'Es tan bueno para lo que cuesta que ni el tramo maximo quita el incentivo de robarlo. ' +
          `La unica defensa es ponerlo fuera del alcance de ${threats[0]!.name}, y sale a cuenta.`,
      }
    }
  }

  return {
    action: 'imposible',
    rationale:
      'Rinde tanto por encima de su precio que ni subiendo al tramo maximo deja de compensarle a ' +
      `un rival pagarlo, y ${threats[0]!.name} tiene saldo de sobra. No hay proteccion posible: o ` +
      'lo vendes tu al precio que quieras, o asumes el robo y cobras la clausula.',
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
