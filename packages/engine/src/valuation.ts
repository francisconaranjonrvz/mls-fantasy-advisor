import type { Euros, Player } from '@mls/core'

/**
 * Valoracion deportiva de un jugador.
 *
 * El valor de mercado de Mister mide DEMANDA, no rendimiento: sube y baja
 * segun el volumen de pujas que recibe. Por eso no sirve directamente para
 * decidir. Lo que necesitamos es cuanto vale un jugador PARA TI en puntos,
 * expresado en euros, para poder compararlo con lo que cuesta ficharlo o
 * protegerlo.
 *
 * El puente es el precio implicito del punto en tu liga: la mediana de
 * valor/puntos entre los jugadores con minutos. Un jugador que rinde por
 * encima de esa mediana vale mas de lo que cuesta, y ese es exactamente el
 * que los rivales querran robarte.
 */

export interface ValuationContext {
  /** Euros de valor de mercado por punto, mediana de la liga. */
  pricePerPoint: number
  /** Jornadas ya disputadas, para pasar de acumulado a media. */
  jornadasPlayed: number
  /** Jornadas que quedan, que es lo unico que ya puedes aprovechar. */
  jornadasRemaining: number
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2)
}

/**
 * Deriva el precio del punto a partir del catalogo.
 *
 * Solo cuentan jugadores con puntuacion positiva y valor real: los que no
 * juegan tienen puntos cero y distorsionarian la mediana hacia el infinito.
 */
export function derivePricePerPoint(players: Player[]): number {
  const ratios = players
    .filter((p) => p.hasTeam && p.points > 0 && p.value > 0)
    .map((p) => p.value / p.points)
  return median(ratios)
}

export function buildValuationContext(
  players: Player[],
  jornadasPlayed: number,
  totalJornadas: number,
): ValuationContext {
  return {
    pricePerPoint: derivePricePerPoint(players),
    jornadasPlayed,
    jornadasRemaining: Math.max(0, totalJornadas - jornadasPlayed),
  }
}

/** Media de puntos por jornada disputada. */
export function pointsPerJornada(player: Player, ctx: ValuationContext): number {
  if (ctx.jornadasPlayed <= 0) return 0
  return player.points / ctx.jornadasPlayed
}

/**
 * Puntos que cabe esperar de un jugador en lo que queda de temporada.
 *
 * Un jugador sin equipo en LaLiga puntua cero pase lo que pase, asi que su
 * valor deportivo es cero por muy alto que sea su precio: hay que venderlo.
 * Un lesionado se penaliza, no se anula, porque volvera.
 */
export function expectedRemainingPoints(player: Player, ctx: ValuationContext): number {
  if (!player.hasTeam) return 0
  const base = pointsPerJornada(player, ctx) * ctx.jornadasRemaining
  const availability =
    player.status === 'injured' ? 0.5 : player.status === 'doubt' ? 0.8 : player.status === 'sanctioned' ? 0.9 : 1
  return base * availability
}

/**
 * Lo que vale un jugador en euros por lo que va a puntuar de aqui al final.
 *
 * Esta es la cifra que hay que comparar con una clausula. Si la clausula de un
 * jugador tuyo es MENOR que esto, robartelo le sale a cuenta a un rival y
 * estas en peligro. Si es MAYOR, que te lo roben es un buen negocio para ti:
 * cobras mas de lo que te aporta.
 */
export function sportingValue(player: Player, ctx: ValuationContext): Euros {
  if (ctx.pricePerPoint <= 0) return player.value
  return Math.round(expectedRemainingPoints(player, ctx) * ctx.pricePerPoint)
}

/**
 * Cuanto mas rinde un jugador de lo que cuesta. Por encima de 1 es un chollo.
 * Es la senal que ordena tanto los objetivos de fichaje como el riesgo propio.
 */
export function valueRatio(player: Player, ctx: ValuationContext): number {
  if (player.value <= 0) return 0
  return sportingValue(player, ctx) / player.value
}
