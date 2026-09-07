import type { Euros, Player, Position } from '@mls/core'

/**
 * Cuanto vale un jugador, en puntos y en euros.
 *
 * El valor de mercado de Mister mide DEMANDA, no rendimiento: sube y baja con
 * el volumen de pujas. Por eso no sirve directamente para decidir. Lo que hace
 * falta es cuanto va a puntuar un jugador de aqui al final, y a que precio se
 * compran esos puntos en esta liga.
 *
 * Dos ideas gobiernan este modulo, y las dos vienen de mirar datos reales:
 *
 * 1. A jornada 4 hay cuatro puntuaciones por jugador. Con esa muestra la media
 *    observada es ruido: el que lleva dos partidos buenos no es el mejor de la
 *    liga, es el que ha tenido suerte. Asi que la media no se usa cruda: se
 *    encoge hacia la media de su posicion en proporcion a lo poco que sabemos
 *    (JORNADAS_DE_PRIOR). Cuantas mas jornadas pasan, menos pesa el prior y
 *    mas pesa el jugador. Es la correccion estandar para muestras cortas, y
 *    aqui es la diferencia entre un modelo util y uno que persigue rachas.
 *
 * 2. La forma reciente informa mas que la antigua, pero menos de lo que la
 *    gente cree. Se pondera con decaimiento suave (DECAIMIENTO), no agresivo.
 */

/** Cuanto pesa el prior de posicion, medido en jornadas equivalentes. */
const JORNADAS_DE_PRIOR = 4

/** Peso relativo de cada jornada hacia atras. 1 seria no ponderar. */
const DECAIMIENTO = 0.85

export interface ValuationContext {
  /** Euros de valor de mercado por punto restante, mediana de la liga. */
  pricePerPoint: number
  /** Jornadas ya disputadas. */
  jornadasPlayed: number
  /** Jornadas que quedan, que es lo unico que ya puedes aprovechar. */
  jornadasRemaining: number
  /** Puntos por jornada del jugador mediano de cada posicion. Es el prior. */
  positionMean: Record<Position, number>
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/**
 * Cuantas jornadas se han disputado, deducido de los propios datos.
 *
 * No se toma del numero de jornada de la pagina porque ese numero es ambiguo:
 * "JORNADA 4" puede significar que van cuatro jugadas o que la cuarta esta por
 * jugarse, y equivocarse desplaza un 25% todas las medias al principio de
 * temporada, que es justo cuando mas fragil es el modelo.
 *
 * Mister da la media por jornada de cada jugador, asi que puntos/media son las
 * jornadas que ha jugado. Para los que no se han perdido ninguna, esa cifra ES
 * la jornada. Se toma la moda, que es la de ese grupo mayoritario, en vez de
 * la media, que la ensucian los suplentes.
 */
export function deriveJornadasPlayed(players: Player[], maxJornadas = 38): number | null {
  const votes = new Map<number, number>()
  for (const p of players) {
    if (!p.average || p.average <= 0 || p.points <= 0) continue
    const n = Math.round(p.points / p.average)
    if (n >= 1 && n <= maxJornadas) votes.set(n, (votes.get(n) ?? 0) + 1)
  }
  if (votes.size === 0) return null

  let best = 0
  let bestVotes = 0
  for (const [n, v] of votes) {
    // En empate gana la mayor: nadie juega mas jornadas de las disputadas, asi
    // que el maximo respaldado es el candidato correcto.
    if (v > bestVotes || (v === bestVotes && n > best)) {
      best = n
      bestVotes = v
    }
  }
  return best
}

/** Puntos por jornada del jugador mediano de cada posicion. */
export function derivePositionMeans(
  players: Player[],
  jornadasPlayed: number,
): Record<Position, number> {
  const acc: Record<Position, number[]> = { GK: [], DF: [], MF: [], FW: [] }
  if (jornadasPlayed <= 0) return { GK: 0, DF: 0, MF: 0, FW: 0 }

  for (const p of players) {
    // Solo cuentan los que juegan. Incluir a los que no han saltado al campo
    // arrastraria el prior hacia cero y con el toda la valoracion.
    if (!p.hasTeam || p.points <= 0) continue
    acc[p.position].push(p.points / jornadasPlayed)
  }
  return {
    GK: median(acc.GK),
    DF: median(acc.DF),
    MF: median(acc.MF),
    FW: median(acc.FW),
  }
}

/**
 * Si hay algun indicio de que el jugador ha jugado.
 *
 * Con la temporada empezada, cero puntos y cero en todas las jornadas de la
 * racha no es falta de datos: es la respuesta. Tratarlo como incognita y
 * asignarle la media de su posicion metia en las cuentas a jugadores que no
 * se han vestido.
 */
export function hasPlayed(player: Player, ctx: ValuationContext): boolean {
  if (ctx.jornadasPlayed <= 0) return true
  if (player.points !== 0) return true
  const streak = player.streak
  if (streak && streak.length > 0) return streak.some((p) => p !== 0)
  return false
}

/**
 * Lo que ha hecho el jugador, ponderando las jornadas recientes por encima de
 * las antiguas. Devuelve null si no hay ni una jornada de la que tirar.
 */
export function observedPointsPerJornada(player: Player, ctx: ValuationContext): number | null {
  const streak = player.streak
  if (streak && streak.length > 0) {
    let num = 0
    let den = 0
    streak.forEach((pts, i) => {
      const w = Math.pow(DECAIMIENTO, i)
      num += w * pts
      den += w
    })
    return den > 0 ? num / den : null
  }
  if (ctx.jornadasPlayed > 0) return player.points / ctx.jornadasPlayed
  return null
}

/**
 * Puntos por jornada que cabe esperar de un jugador.
 *
 * Mezcla lo que ha hecho con lo que hace un jugador tipico de su posicion, en
 * proporcion a cuanto sabemos de el. Con cuatro jornadas jugadas el peso es
 * 4/(4+4), o sea la mitad; con veinte, cinco sextos.
 */
export function expectedPointsPerJornada(player: Player, ctx: ValuationContext): number {
  if (!player.hasTeam) return 0
  // Quien no ha jugado ni un minuto en toda la temporada no es un jugador
  // medio del que sepamos poco: es un suplente del que sabemos bastante. El
  // prior de su posicion no le aplica, porque describe a los que juegan.
  if (!hasPlayed(player, ctx)) return 0

  const prior = ctx.positionMean[player.position]
  const observed = observedPointsPerJornada(player, ctx)
  if (observed === null) return prior

  const n = ctx.jornadasPlayed
  const peso = n / (n + JORNADAS_DE_PRIOR)
  return peso * observed + (1 - peso) * prior
}

/** Multiplicador de disponibilidad. Un lesionado vuelve; uno sin equipo no. */
export function availability(player: Player): number {
  if (!player.hasTeam) return 0
  switch (player.status) {
    case 'injured': return 0.5
    case 'doubt': return 0.8
    case 'sanctioned': return 0.9
    case 'no_team': return 0
    default: return 1
  }
}

/** Puntos que cabe esperar de un jugador en lo que queda de temporada. */
export function expectedRemainingPoints(player: Player, ctx: ValuationContext): number {
  return expectedPointsPerJornada(player, ctx) * ctx.jornadasRemaining * availability(player)
}

/**
 * Precio de un punto en esta liga: la mediana de euros de valor de mercado por
 * punto que le queda por dar a cada jugador.
 *
 * Es el tipo de cambio de referencia. Un jugador por debajo de la mediana da
 * puntos mas baratos que el mercado; uno por encima, mas caros.
 */
export function derivePricePerPoint(players: Player[], ctx: ValuationContext): number {
  const ratios: number[] = []
  for (const p of players) {
    if (!p.hasTeam || p.value <= 0) continue
    const rem = expectedRemainingPoints(p, ctx)
    if (rem > 0) ratios.push(p.value / rem)
  }
  return median(ratios)
}

/**
 * Construye el contexto a partir del catalogo.
 *
 * `jornadasHint` es lo que dice la pagina. Solo se usa si los datos no dan
 * para deducirlo, porque los datos son mas fiables que esa etiqueta.
 */
export function buildValuationContext(
  players: Player[],
  jornadasHint: number,
  totalJornadas: number,
  /**
   * Numeros de jornada ya puntuados, si se conocen.
   *
   * En esta liga son J2, J3, J4 y J6: cuatro puntuadas, pero seis consumidas
   * del calendario. Son dos cifras distintas y las dos hacen falta. Los puntos
   * por jornada se dividen entre las CUATRO en las que se puntuo; lo que queda
   * por jugar se cuenta desde la SEXTA. Usar 38 menos cuatro daria treinta y
   * cuatro jornadas por delante cuando en realidad quedan treinta y dos, y
   * toda la proyeccion saldria un 6% alta.
   */
  scoredJornadas?: number[],
): ValuationContext {
  const derived = deriveJornadasPlayed(players, totalJornadas)
  const jornadasPlayed =
    scoredJornadas && scoredJornadas.length > 0
      ? scoredJornadas.length
      : Math.min(totalJornadas, Math.max(0, derived ?? jornadasHint))

  const ultimaDelCalendario =
    scoredJornadas && scoredJornadas.length > 0 ? Math.max(...scoredJornadas) : jornadasPlayed

  const ctx: ValuationContext = {
    pricePerPoint: 0,
    jornadasPlayed,
    jornadasRemaining: Math.max(0, totalJornadas - ultimaDelCalendario),
    positionMean: derivePositionMeans(players, jornadasPlayed),
  }
  // El precio del punto depende de la proyeccion, asi que se calcula cuando ya
  // esta lista la parte deportiva del contexto.
  ctx.pricePerPoint = derivePricePerPoint(players, ctx)
  return ctx
}

/** Media de puntos por jornada disputada, sin correcciones. */
export function pointsPerJornada(player: Player, ctx: ValuationContext): number {
  if (ctx.jornadasPlayed <= 0) return 0
  return player.points / ctx.jornadasPlayed
}

/**
 * Lo que vale un jugador en euros por lo que va a puntuar de aqui al final,
 * valorado al precio del punto de esta liga.
 *
 * Es un PRECIO JUSTO, no una recomendacion. Sirve para saber si un jugador
 * esta caro o barato para lo que rinde, pero por si solo no dice si conviene
 * ficharlo: eso depende de a quien desplace en tu once, y de eso se ocupa
 * marginal.ts.
 */
export function sportingValue(player: Player, ctx: ValuationContext): Euros {
  if (ctx.pricePerPoint <= 0) return 0
  return Math.round(expectedRemainingPoints(player, ctx) * ctx.pricePerPoint)
}

/**
 * Cuanto mas rinde un jugador de lo que cuesta. Por encima de 1 es un chollo.
 * Por construccion el jugador mediano de la liga esta en 1.
 */
export function valueRatio(player: Player, ctx: ValuationContext): number {
  if (player.value <= 0) return 0
  return sportingValue(player, ctx) / player.value
}
