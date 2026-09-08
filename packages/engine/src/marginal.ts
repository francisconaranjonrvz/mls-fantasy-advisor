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
  /**
   * Penalizacion por hueco que el fichaje evita, por jornada.
   *
   * Se devuelve APARTE de `perJornada` a proposito, y la distincion importa.
   * Son dos preguntas que se responden distinto:
   *
   *  - Cuanto vale este jugador. Eso es `perJornada`, y no incluye esto,
   *    porque el hueco lo tapa igual de bien el suplente mas barato del
   *    mercado libre. Pagarle una clausula de cuatro millones a un titular
   *    ajeno para evitar una penalizacion de cuatro puntos es un mal negocio.
   *
   *  - Que urge hacer esta jornada. Eso si es esto: mientras el hueco siga
   *    abierto se pierden puntos de verdad, cada jornada.
   *
   * Mezclarlas es lo que inflaba el analisis: la urgencia se sumaba al precio
   * del jugador y ademas se multiplicaba por las jornadas que quedan.
   */
  gapRelief: number
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
  // A quien ya tienes no lo puedes fichar, y preguntarlo no es inofensivo: al
  // anadirlo se cuela DOS VECES en la plantilla, el optimizador lo pone en dos
  // huecos de su posicion y le cuenta los puntos por duplicado.
  //
  // Pasaba de verdad. En Mister puedes poner a los tuyos en venta, y entonces
  // salen en el mercado como cualquier otro: el asesor recomendaba fichar a
  // Hancko, que ya era de la plantilla, por 8.587.000 que era su propio precio
  // de venta.
  if (squad.some((p) => p.id === candidate.id)) {
    return { perJornada: 0, remaining: 0, entersLineup: false, gapRelief: 0 }
  }

  const sinEl = baseline ?? optimizeLineup(squad, ctx, config).best
  const conEl = optimizeLineup(
    [...squad, asOwned(candidate, squad[0]?.ownerId ?? 0)],
    ctx,
    config,
  ).best

  // Se restan los puntos BRUTOS, no los penalizados, y esto era un fallo.
  //
  // `expectedPoints` lleva descontada la penalizacion por hueco sin cubrir: 4
  // puntos por jornada y hueco. Al restar dos onces penalizados, quien tapaba
  // un hueco se llevaba sus propios puntos MAS los 4 de la penalizacion
  // evitada, y esos 4 no son suyos: los evita cualquiera que ocupe el hueco,
  // incluido un suplente de 100.000 euros del mercado libre.
  //
  // Peor aun, la penalizacion se capitalizaba multiplicandola por las jornadas
  // que quedan, como si el hueco fuera a seguir abierto hasta junio. Contra
  // los datos reales de la liga eso metia 4 x 32 = 128 puntos, unos 3,97
  // millones, en el beneficio del robo de CADA jugador. Constante, identica
  // para todos, y por tanto invisible al comparar unos con otros: solo se veia
  // al contrastar la ganancia con los puntos que el jugador puede dar.
  //
  // Como el beneficio del robo se queda con el rival al que mas le compensa,
  // mandaba siempre el rival con la plantilla mas corta, y toda la plantilla
  // propia salia en riesgo alto.
  const perJornada = Math.max(0, conEl.rawPoints - sinEl.rawPoints)
  const entersLineup = conEl.slots.some((s) => s.player?.id === candidate.id)
  // La penalizacion es negativa, asi que evitarla es la diferencia al reves.
  const gapRelief = Math.max(0, conEl.penalty - sinEl.penalty)

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
    gapRelief,
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
  const mejor = rankMarketBuys(offers, squad, ctx, config, capacity)[0]
  if (!mejor) return { costPerPoint: Number.POSITIVE_INFINITY }
  return { costPerPoint: mejor.costPerPoint, player: mejor.player, price: mejor.price }
}

export interface MarketBuy {
  player: Player
  price: Euros
  gain: MarginalGain
  costPerPoint: number
}

/**
 * Las ofertas del mercado abierto que mejoran tu once, de la mas barata por
 * punto a la mas cara.
 *
 * Es la respuesta a "a quien ficho hoy" cuando ningun clausulazo compensa, que
 * con el mercado bien de precio es lo normal. Sin esta lista, el asesor se
 * quedaba sin nada que decir justo cuando la respuesta era la mas facil.
 */
export function rankMarketBuys(
  offers: { player: Player; price: Euros }[],
  squad: OwnedPlayer[],
  ctx: ValuationContext,
  config: LeagueConfig,
  capacity: Euros,
): MarketBuy[] {
  const baseline = optimizeLineup(squad, ctx, config).best
  const out: MarketBuy[] = []

  const yaEsTuyo = new Set(squad.map((p) => p.id))

  for (const offer of offers) {
    if (offer.price > capacity || offer.price <= 0) continue
    // Los tuyos puestos en venta aparecen en el mercado igual que los demas.
    if (yaEsTuyo.has(offer.player.id)) continue
    const gain = marginalGain(offer.player, squad, ctx, config, baseline)
    if (gain.remaining <= 0) continue
    out.push({ ...offer, gain, costPerPoint: costPerPoint(offer.price, gain) })
  }
  return out.sort((a, b) => a.costPerPoint - b.costPerPoint)
}

/**
 * Puntos por jornada que aporta un jugador sin mirar el once. Se usa para
 * ordenar candidatos antes de hacer el calculo caro.
 */
export function rawPointsPerJornada(player: Player, ctx: ValuationContext): number {
  return expectedPointsPerJornada(player, ctx) * availability(player)
}
