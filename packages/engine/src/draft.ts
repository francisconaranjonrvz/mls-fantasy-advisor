import type { Euros, OwnedPlayer, Transaction, LeagueConfig } from '@mls/core'

/**
 * Cuanto valia la plantilla que le repartieron a cada manager.
 *
 * Es el termino que decide todo lo demas, porque la caja de partida es el
 * presupuesto menos ese valor, y sobre esa caja se apila el resto del libro.
 *
 * Me equivoque con esto. Al ver que mi propio apunte de reparto eran 12.472.000
 * sobre 50M, o sea el 24,944%, lo tome por una regla del juego: Mister reparte
 * plantilla por el 75% del presupuesto. La cifra se quedaba a un 0,056% del 25%
 * exacto y parecia demasiado redonda para ser casualidad.
 *
 * Los datos dicen que no. Aplicando esa regla a los nueve rivales, seis salian
 * comprando el primer dia mas dinero del que la regla les daba: jose-maria
 * gasto 12,5M el 17 de agosto y otros 11,5M el 18. Reconstruyendo lo que
 * necesitaban para que sus movimientos fueran posibles, las plantillas
 * repartidas iban de 18,6M a 52M. El reparto es aleatorio de verdad, y yo
 * generalice a partir de una sola observacion: la mia.
 *
 * Asi que aqui no se supone: se calcula. La plantilla repartida a un manager es
 * la que tiene hoy menos lo que ha comprado, mas lo que ha vendido de lo que le
 * repartieron. Todo eso sale del feed, jugador a jugador.
 */

export interface DraftEstimate {
  managerId: number
  /** Valor estimado de la plantilla repartida. */
  squadValue: Euros
  /** Caja con la que arranco: presupuesto menos lo anterior. */
  initialCash: Euros
  /** Cuantos de los jugadores repartidos sigue teniendo. */
  retained: number
  /** Cuantos vendio. */
  sold: number
  /**
   * Si la estimacion se apoya en datos completos.
   *
   * Los jugadores que conserva se valoran a precio de HOY, no al del dia del
   * reparto, porque el valor de entonces no se publica. Tres semanas de mercado
   * mueven poco, pero no nada, asi que la cifra lleva su margen.
   */
  fromRetainedValue: Euros
  fromSalePrices: Euros
  /**
   * Cuanto puede estar equivocada la cifra.
   *
   * Solo la parte de los jugadores conservados: esos se valoran a precio de
   * hoy y el mercado lleva tres semanas moviendose. Lo que vendio se cuenta al
   * precio real de venta, que es dato exacto y no aporta error.
   */
  uncertainty: Euros
}

/**
 * Cuanto puede haberse movido el valor de un jugador desde el reparto.
 *
 * Mister revaloriza a diario segun la demanda. Un 15% cubre holgadamente tres
 * semanas sin fingir que el precio de hoy es el de entonces.
 */
export const MARKET_DRIFT = 0.15

const COMPRAS = new Set(['purchase', 'buyout_signing'])
const VENTAS = new Set(['sale', 'buyout_sale'])

/**
 * Estima la plantilla repartida a un manager a partir de su libro.
 *
 * La idea es de contabilidad elemental: lo que tiene hoy es lo que le
 * repartieron, menos lo que vendio de aquello, mas lo que ha comprado. Despejar
 * el reparto solo pide saber que jugadores de los de hoy llegaron comprados, y
 * eso lo dice el feed por id de jugador.
 */
export function estimateDraft(
  managerId: number,
  squad: OwnedPlayer[],
  transactions: Transaction[],
  config: LeagueConfig,
): DraftEstimate {
  const suyas = transactions.filter((t) => t.managerId === managerId)

  const comprados = new Set<number>()
  for (const t of suyas) {
    if (COMPRAS.has(t.type) && t.playerId !== undefined) comprados.add(t.playerId)
  }

  // Los que conserva del reparto: los que tiene hoy y nunca compro.
  const conservados = squad.filter((p) => !comprados.has(p.id))
  const fromRetainedValue = conservados.reduce((acc, p) => acc + p.value, 0)

  // Los que vendio del reparto: los que vendio y nunca compro. Se valoran al
  // precio al que los vendio, que es dato exacto.
  const vendidosDelReparto = suyas.filter(
    (t) => VENTAS.has(t.type) && t.playerId !== undefined && !comprados.has(t.playerId),
  )
  const fromSalePrices = vendidosDelReparto.reduce((acc, t) => acc + Math.abs(t.amount), 0)

  const squadValue = fromRetainedValue + fromSalePrices

  return {
    managerId,
    squadValue,
    initialCash: config.initialBudget - squadValue,
    retained: conservados.length,
    sold: vendidosDelReparto.length,
    fromRetainedValue,
    fromSalePrices,
    uncertainty: Math.round(fromRetainedValue * MARKET_DRIFT),
  }
}

/**
 * Caja de partida MINIMA compatible con lo que hizo.
 *
 * Independiente de la anterior y mucho mas dura: nadie puede quedarse por
 * debajo del margen de deuda en ningun momento, asi que se recorre el libro en
 * orden, se mira el punto mas bajo y de ahi sale el suelo. Sirve de contraste:
 * si la estimacion del reparto queda por debajo de este suelo, la estimacion
 * esta mal.
 */
export function minimumInitialCash(
  managerId: number,
  teamValue: Euros,
  transactions: Transaction[],
  config: LeagueConfig,
): Euros {
  const suyas = transactions
    .filter((t) => t.managerId === managerId && t.date)
    .sort((a, b) => a.date.localeCompare(b.date))

  let acumulado = 0
  let minimo = 0
  for (const t of suyas) {
    acumulado += t.amount
    if (acumulado < minimo) minimo = acumulado
  }

  const margen = Math.round(teamValue * config.maxDebtPctOfTeamValue)
  return Math.max(0, -margen - minimo)
}
