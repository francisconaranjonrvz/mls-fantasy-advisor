import type { Euros, OwnedPlayer } from '@mls/core'

/**
 * Mecanica de cláusulas de rescision de Mister.
 *
 * Fuente: help.playmister.com/article/86-clausulas-de-rescision
 *
 * Sea B = max(precio_compra, valor_de_mercado).
 *   - Cláusula por defecto = 1,5 x B  (suelo de 1M si el valor cae a <= 666.666).
 *   - Se puede subir en tres tramos: +100%, +150%, +200% del valor,
 *     que producen cláusulas de 2,0B / 2,5B / 3,0B.
 *   - Coste oficial = "el 20% del valor maximo de la cláusula / 3 x numero del aumento"
 *     = (0,20 x 3B) / 3 x n = 0,2 x B x n.
 *
 * De ahi sale el hecho mas util de todo el juego: el tipo de cambio es CONSTANTE.
 * Cada tramo cuesta 0,2B y aporta 0,5B de proteccion extra, asi que proteger
 * 1 EUR cuesta siempre 0,40 EUR, en los tres tramos. No hay tramo "mas rentable":
 * la decision es a QUIEN proteger, no con que tramo.
 */

/** 0 = cláusula por defecto (no se ha pagado nada). 1..3 = tramos comprados. */
export type ClauseTier = 0 | 1 | 2 | 3

export const CLAUSE_TIERS: readonly ClauseTier[] = [0, 1, 2, 3] as const

/** Multiplicador sobre B para cada tramo. */
export const CLAUSE_MULTIPLIER: Record<ClauseTier, number> = {
  0: 1.5,
  1: 2.0,
  2: 2.5,
  3: 3.0,
}

/** Etiqueta que muestra Mister para cada tramo. */
export const CLAUSE_TIER_LABEL: Record<ClauseTier, string> = {
  0: 'por defecto',
  1: '+100%',
  2: '+150%',
  3: '+200%',
}

/** Coste de cada tramo como fraccion de B. */
export const CLAUSE_COST_FACTOR = 0.2

/** Si el valor de mercado cae a este umbral o por debajo, la cláusula pasa a 1M. */
export const CLAUSE_FLOOR_VALUE_THRESHOLD = 666_666
export const CLAUSE_FLOOR = 1_000_000

/** Euros de saldo por cada euro de proteccion adicional. Constante en los 3 tramos. */
export const CLAUSE_EXCHANGE_RATE = 0.4

/** Al bajar una cláusula subida se recupera la mitad de lo invertido. */
export const CLAUSE_REFUND_PCT = 0.5
/** Tras bajarla, no se puede volver a subir durante 48 horas. */
export const CLAUSE_RERAISE_LOCK_HOURS = 48

/**
 * B = max(precio de compra, valor de mercado actual).
 * Si no conocemos el precio de compra, el valor de mercado es la mejor cota.
 */
export function clauseBase(player: Pick<OwnedPlayer, 'value' | 'purchasePrice'>): Euros {
  return Math.max(player.purchasePrice ?? 0, player.value)
}

/** Cláusula sin haber pagado nada. */
export function defaultClause(base: Euros, marketValue: Euros = base): Euros {
  if (marketValue <= CLAUSE_FLOOR_VALUE_THRESHOLD) return CLAUSE_FLOOR
  return Math.round(base * CLAUSE_MULTIPLIER[0])
}

/** Cláusula resultante de comprar un tramo concreto. */
export function clauseForTier(base: Euros, tier: ClauseTier, marketValue: Euros = base): Euros {
  if (tier === 0) return defaultClause(base, marketValue)
  return Math.round(base * CLAUSE_MULTIPLIER[tier])
}

/** Coste en saldo de subir del tramo por defecto al tramo `tier`. */
export function tierCost(base: Euros, tier: ClauseTier): Euros {
  if (tier === 0) return 0
  return Math.round(CLAUSE_COST_FACTOR * base * tier)
}

/**
 * Coste de pasar de un tramo ya pagado a otro superior.
 * Mister cobra por tramo, asi que subir de 1 a 3 cuesta la diferencia.
 */
export function upgradeCost(base: Euros, from: ClauseTier, to: ClauseTier): Euros {
  if (to <= from) return 0
  return tierCost(base, to) - tierCost(base, from)
}

/**
 * El tramo mas barato que deja la cláusula estrictamente por encima de `target`.
 * Devuelve null si ni el tramo maximo (3,0B) llega: ese jugador no se puede
 * proteger de ese rival, y gastar en el es tirar el dinero.
 */
export function cheapestTierAbove(
  base: Euros,
  target: Euros,
  marketValue: Euros = base,
): ClauseTier | null {
  for (const tier of CLAUSE_TIERS) {
    if (clauseForTier(base, tier, marketValue) > target) return tier
  }
  return null
}

/**
 * Cláusula efectiva teniendo en cuenta el "ratchet" asimetrico: una cláusula
 * pagada sube proporcionalmente si el valor del jugador sube, pero se congela
 * si el valor baja.
 *
 * Esta asimetria es la razon de que solo merezca la pena proteger jugadores
 * que esperas que se revaloricen: compras un multiplicador, no una cifra fija.
 */
export function effectiveClause(
  tier: ClauseTier,
  baseWhenPaid: Euros,
  currentBase: Euros,
  currentMarketValue: Euros = currentBase,
): Euros {
  if (tier === 0) return defaultClause(currentBase, currentMarketValue)
  return Math.round(Math.max(baseWhenPaid, currentBase) * CLAUSE_MULTIPLIER[tier])
}

/** Dinero recuperado al bajar la cláusula al tramo por defecto. */
export function refundOnLowering(spent: Euros): Euros {
  return Math.round(spent * CLAUSE_REFUND_PCT)
}

/**
 * Coste real de la proteccion si acabas deshaciendo la subida: 0,40 menos el
 * 50% que recuperas = 0,20 EUR por euro protegido. Por eso el dinero metido en
 * cláusulas es una reserva semiliquida, no un gasto hundido.
 */
export const CLAUSE_EFFECTIVE_RATE_IF_UNWOUND = CLAUSE_EXCHANGE_RATE * (1 - CLAUSE_REFUND_PCT)

/** Un jugador esta blindado si su ventana de 7 dias post-fichaje sigue abierta. */
export function isShielded(player: Pick<OwnedPlayer, 'shieldedUntil'>, now: Date): boolean {
  if (!player.shieldedUntil) return false
  const until = Date.parse(player.shieldedUntil)
  return Number.isFinite(until) && until > now.getTime()
}
