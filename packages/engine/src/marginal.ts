import type { Euros, LeagueConfig, OwnedPlayer, Player } from '@mls/core'
import { optimizeLineup, type LineupPlan } from './lineup.ts'
import { expectedPointsPerJornada, availability, type ValuationContext } from './valuation.ts'

/**
 * Lo que un fichaje te aporta DE VERDAD.
 *
 * Es la correccion mas importante del motor, y la que hace que el analisis
 * discrimine en vez de dar el mismo veredicto para toda la plantilla.
 *
 * El error natural es valorar a un jugador por lo que puntua. Pero tu no
 * puntuas con jugadores, puntuas con un once. Si fichas a un centrocampista de
 * 8 puntos por jornada y el que ya tenias en ese hueco daba 7, ese fichaje te
 * aporta 1, no 8. Y si el fichado ni siquiera entra en el once, aporta 0 por
 * bueno que sea.
 *
 * De ahi salen dos consecuencias que no se ven con el modelo ingenuo:
 *
 *  - Un crack en una posicion en la que ya vas sobrado casi no vale nada. Es
 *    la razon por la que hay clausulazos caros que no compensan aunque el
 *    jugador sea claramente bueno.
 *  - Un jugador mediano en la posicion en la que estas cojo puede valer mucho.
 *
 * Y sirve igual para defender: para saber si un rival te va a robar a alguien,
 * lo que importa no es lo bueno que sea el jugador sino cuanto mejoraria EL
 * ONCE DEL RIVAL. Un delantero tuyo excelente no corre peligro si el rival ya
 * tiene tres mejores.
 */

export interface MarginalGain {
  /** Puntos por jornada que suma al once. Nunca negativo. */
  perJornada: number
  /** Puntos que suma en lo que queda de temporada. */
  remaining: number
  /** A quien deja en el banquillo. undefined si solo rellena un hueco vacio. */
  displaces?: OwnedPlayer | undefined
  /** Si no entra en el once, el fichaje no aporta nada hoy. */
  entersLineup: boolean
}

/** Un jugador cualquiera visto como si ya fuera de la plantilla. */
function asOwned(player: Player, ownerId: number): OwnedPlayer {
  if ('onMarket' in player && 'ownerId' in player && typeof player.ownerId === 'number') {
    return player as OwnedPlayer
  }
  return { ...player, ownerId, onMarket: false }
}

/**
 * Cuanto mejora un once al anadir un jugador.
 *
 * Se calcula por diferencia real: se optimiza el once sin el y con el, y se
 * resta. No hay heuristica que sustituya a esto, porque el efecto depende de
 * la formacion optima, que puede cambiar precisamente por culpa del fichaje.
 */
export function marginalGain(
  candidate: Player,
  squad: OwnedPlayer[],
  ctx: ValuationContext,
  config: LeagueConfig,
  baseline?: LineupPlan,
): MarginalGain {
  const sinEl = baseline ?? optimizeLineup(squad, ctx, config).best
  const conEl = optimizeLineup(
    [...squad, asOwned(candidate, squad[0]?.ownerId ?? 0)],
    ctx,
    config,
  ).best

  const perJornada = Math.max(0, conEl.expectedPoints - sinEl.expectedPoints)
  const entersLineup = conEl.slots.some((s) => s.player?.id === candidate.id)

  // A quien desplaza: el que estaba en el once antes y ya no esta.
  const antes = new Set(sinEl.slots.map((s) => s.player?.id).filter((id): id is number => !!id))
  const despues = new Set(conEl.slots.map((s) => s.player?.id).filter((id): id is number => !!id))
  const fuera = [...antes].find((id) => !despues.has(id))
  const displaces = fuera !== undefined ? squad.find((p) => p.id === fuera) : undefined

  return {
    perJornada,
    remaining: perJornada * ctx.jornadasRemaining,
    displaces,
    entersLineup,
  }
}

/**
 * Lo que cuesta cada punto que ese fichaje suma a tu once.
 *
 * Es la cifra con la que se comparan alternativas que no se parecen en nada:
 * un clausulazo de 20M, una puja de 3M en el mercado y quedarse el dinero. Un
 * numero mas bajo es mejor. Infinito significa que no aporta nada y por tanto
 * no hay precio al que compense.
 */
export function costPerPoint(cost: Euros, gain: MarginalGain): number {
  if (gain.remaining <= 0) return Number.POSITIVE_INFINITY
  return cost / gain.remaining
}

/**
 * Referencia contra la que juzgar cualquier compra: lo que cuesta el punto mas
 * barato que puedes comprar hoy en el mercado abierto.
 *
 * Sin esta referencia, "gano 12 puntos por 20M" no significa nada. Con ella,
 * la pregunta pasa a ser la correcta: si esos mismos 20M en el mercado te dan
 * 30 puntos, el clausulazo es malo aunque su beneficio sea positivo.
 *
 * Si el mercado no ofrece nada aprovechable devuelve infinito, que es lo
 * honesto: significa que no hay alternativa y cualquier mejora vale.
 */
export function marketBenchmark(
  offers: { player: Player; price: Euros }[],
  squad: OwnedPlayer[],
  ctx: ValuationContext,
  config: LeagueConfig,
  capacity: Euros,
): { costPerPoint: number; player?: Player | undefined; price?: Euros | undefined } {
  const baseline = optimizeLineup(squad, ctx, config).best
  let best = Number.POSITIVE_INFINITY
  let bestPlayer: Player | undefined
  let bestPrice: Euros | undefined

  for (const offer of offers) {
    if (offer.price > capacity) continue
    const cpp = costPerPoint(
      offer.price,
      marginalGain(offer.player, squad, ctx, config, baseline),
    )
    if (cpp < best) {
      best = cpp
      bestPlayer = offer.player
      bestPrice = offer.price
    }
  }
  return { costPerPoint: best, player: bestPlayer, price: bestPrice }
}

/**
 * Puntos por jornada que aporta un jugador sin mirar el once. Se usa para
 * ordenar candidatos antes de hacer el calculo caro.
 */
export function rawPointsPerJornada(player: Player, ctx: ValuationContext): number {
  return expectedPointsPerJornada(player, ctx) * availability(player)
}
