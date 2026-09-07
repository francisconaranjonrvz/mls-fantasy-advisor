import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type Transaction, type LeagueConfig } from '@mls/core'
import {
  reconstructBalance, bonusesFromRanks, quinielaRange, salaryRange,
  calibrate, exactBalance, spendingCapacity, observedInitialCash,
} from './balances.ts'

const tx = (
  type: Transaction['type'],
  amount: number,
  managerId = 1,
): Transaction => ({ date: '2026-09-10T05:00:00', type, amount, managerId })

/** Liga sin quiniela ni salarios: el saldo queda completamente determinado. */
const DETERMINISTIC: LeagueConfig = {
  ...MLS_LEAGUE,
  quinielaEnabled: false,
  salaries: { ...MLS_LEAGUE.salaries, enabled: true },
}

describe('bonificaciones por puesto', () => {
  it('usa la escalera invertida: el ultimo cobra mas que el primero', () => {
    expect(bonusesFromRanks([{ jornada: 1, rank: 1 }], MLS_LEAGUE)).toBe(M(1.0))
    expect(bonusesFromRanks([{ jornada: 1, rank: 10 }], MLS_LEAGUE)).toBe(M(1.5))
  })

  it('acumula varias jornadas', () => {
    const ranks = [
      { jornada: 1, rank: 1 },
      { jornada: 2, rank: 10 },
      { jornada: 3, rank: 5 },
    ]
    expect(bonusesFromRanks(ranks, MLS_LEAGUE)).toBe(M(1.0) + M(1.5) + M(1.2))
  })

  it('acota puestos fuera de rango en vez de devolver NaN', () => {
    expect(bonusesFromRanks([{ jornada: 1, rank: 99 }], MLS_LEAGUE)).toBe(M(1.5))
    expect(bonusesFromRanks([{ jornada: 1, rank: 0 }], MLS_LEAGUE)).toBe(M(1.0))
  })
})

describe('reconstruccion con todo conocido', () => {
  // Plantilla inicial de 30M => arranca con 20M de saldo.
  // Compra de 8M, venta de 5M, le pagan una clausula de 12M, sube una
  // clausula por 2M, y una jornada de 3er puesto (1,1M).
  const estimate = reconstructBalance(
    {
      managerId: 1,
      initialSquadValue: M(30),
      historyComplete: true,
      teamValue: M(40),
      averageLineupValue: 0,
      jornadaRanks: [{ jornada: 1, rank: 3 }],
      transactions: [
        tx('purchase', M(-8)),
        tx('sale', M(5)),
        tx('buyout_sale', M(12)),
        tx('clause_change', M(-2)),
      ],
    },
    DETERMINISTIC,
  )

  it('cuadra la aritmetica', () => {
    // 20 - 8 + 5 + 12 - 2 + 1,1 = 28,1M
    expect(estimate.estimate).toBe(M(28.1))
  })

  it('sin incognitas el intervalo colapsa a un punto', () => {
    expect(estimate.low).toBe(estimate.high)
    expect(estimate.unknowns).toEqual([])
  })
})

describe('propagacion de la incertidumbre', () => {
  const base = {
    managerId: 2,
    initialSquadValue: M(30),
    historyComplete: true,
    teamValue: M(40),
    averageLineupValue: M(30),
    jornadaRanks: [{ jornada: 1, rank: 5 }, { jornada: 2, rank: 5 }],
    transactions: [tx('purchase', M(-8))],
  }

  it('la quiniela abre el intervalo', () => {
    const e = reconstructBalance(base, MLS_LEAGUE)
    expect(e.high).toBeGreaterThan(e.low)
    expect(e.unknowns.join(' ')).toMatch(/quiniela/)
  })

  it('los salarios ya no lo abren, porque estan comprobados', () => {
    // Mientras el interruptor era una captura y no un dato, habia que evaluar
    // las dos ramas y eso metia el cargo entero como incertidumbre.
    const e = reconstructBalance(base, MLS_LEAGUE)
    expect(e.unknowns.join(' ')).not.toMatch(/salarios/)

    const sinConfirmar: LeagueConfig = {
      ...MLS_LEAGUE,
      salaries: { ...MLS_LEAGUE.salaries, confirmed: false },
    }
    const dudoso = reconstructBalance(base, sinConfirmar)
    expect(dudoso.high - dudoso.low).toBeGreaterThan(e.high - e.low)
    expect(dudoso.unknowns.join(' ')).toMatch(/salarios/)
  })

  it('el saldo real cae dentro del intervalo', () => {
    const e = reconstructBalance(base, MLS_LEAGUE)
    // Verdad: 20 - 8 + 2 jornadas a 1,2M = 14,4M, sin quiniela ni salarios.
    expect(M(14.4)).toBeGreaterThanOrEqual(e.low)
    expect(M(14.4)).toBeLessThanOrEqual(e.high)
  })

  it('un historial incompleto ensancha mucho el intervalo', () => {
    const completo = reconstructBalance(base, MLS_LEAGUE)
    const parcial = reconstructBalance({ ...base, historyComplete: false }, MLS_LEAGUE)
    expect(parcial.high - parcial.low).toBeGreaterThan(completo.high - completo.low)
    expect(parcial.unknowns.join(' ')).toMatch(/historial/)
  })
})

describe('restricciones del juego que estrechan el intervalo', () => {
  it('si puntuo, no pudo arrancar la jornada en negativo', () => {
    const e = reconstructBalance(
      {
        managerId: 3,
        initialSquadValue: M(48),
        historyComplete: true,
        teamValue: M(50),
        averageLineupValue: M(40),
        jornadaRanks: [{ jornada: 1, rank: 1 }],
        scoredJornadas: [1],
        transactions: [tx('purchase', M(-5))],
      },
      MLS_LEAGUE,
    )
    expect(e.low).toBeGreaterThanOrEqual(0)
    expect(e.constraintsApplied.join(' ')).toMatch(/negativo/)
  })

  it('un desembolso grande demuestra un suelo, pero de la caja de PARTIDA', () => {
    /**
     * Aqui tenia un error de razonamiento. Exigia el mayor desembolso del
     * saldo de HOY, y eso no se sigue: se puede pagar un clausulazo de 30M y
     * quedarse despues a cero. Lo que si se sigue es que la caja de partida
     * daba para llegar hasta ahi sin pasarse del margen de deuda.
     *
     * Pago 30M con 10M de margen, luego arranco con 20M como minimo. Si
     * despues no ingreso nada, hoy tiene al menos 20 - 30 + 10 = 0... o sea,
     * el suelo de hoy es la caja minima mas todo lo movido.
     */
    const e = reconstructBalance(
      {
        managerId: 4,
        historyComplete: true,
        teamValue: M(40),        // margen de deuda = 10M
        averageLineupValue: M(30),
        jornadaRanks: [],
        clauseRaisesObserved: true,
        transactions: [tx('buyout_signing', M(-30)), tx('sale', M(25))],
      },
      MLS_LEAGUE,
    )
    // Caja minima 20M, movimientos netos -5M => suelo de hoy 15M. Pero el
    // reparto solo da 12,5M, asi que la restriccion y la reconstruccion no
    // pueden ser las dos ciertas y se declara la inconsistencia.
    expect(e.unknowns.join(' ')).toMatch(/solvencia observada no cuadra/)
  })

  it('no exige del saldo de hoy lo que se pago hace tres semanas', () => {
    // Pago 30M y luego se lo gasto todo. Su saldo de hoy puede ser cero sin
    // que eso contradiga nada, y antes esto salia como contradiccion.
    const e = reconstructBalance(
      {
        managerId: 5,
        historyComplete: true,
        teamValue: M(40),
        averageLineupValue: M(30),
        jornadaRanks: [],
        clauseRaisesObserved: true,
        // Pago 20M el dia 20, cobro 28M el 21 y volvio a gastar 5M en
        // septiembre. Con 10M de margen le bastaba con arrancar con 10M, que
        // es menos que los 12,5M que reparte la regla: todo cuadra.
        transactions: [
          { ...tx('buyout_signing', M(-20)), date: '2026-08-20T05:00:00Z' },
          { ...tx('sale', M(28)), date: '2026-08-21T05:00:00Z' },
          { ...tx('purchase', M(-5)), date: '2026-09-01T05:00:00Z' },
        ],
      },
      MLS_LEAGUE,
    )
    expect(e.high).toBeGreaterThanOrEqual(e.low)
    expect(e.unknowns.join(' ')).not.toMatch(/contradicen/)
  })
})

describe('calibracion contra el saldo real', () => {
  it('detecta que la reconstruccion acierta', () => {
    const e = reconstructBalance(
      {
        managerId: 1, initialSquadValue: M(30), historyComplete: true,
        teamValue: M(40), averageLineupValue: 0, jornadaRanks: [],
        transactions: [tx('purchase', M(-8))],
      },
      DETERMINISTIC,
    )
    const c = calibrate(e, M(12))
    expect(c.error).toBe(0)
    expect(c.withinInterval).toBe(true)
  })

  it('detecta y cuantifica una desviacion', () => {
    const e = reconstructBalance(
      {
        managerId: 1, initialSquadValue: M(30), historyComplete: true,
        teamValue: M(40), averageLineupValue: 0, jornadaRanks: [],
        transactions: [tx('purchase', M(-8))],
      },
      DETERMINISTIC,
    )
    const c = calibrate(e, M(10))
    expect(c.error).toBe(M(2))
    expect(c.withinInterval).toBe(false)
  })
})

describe('capacidad de gasto', () => {
  const e = exactBalance(1, M(10))

  it('suma el 25% del valor de equipo', () => {
    expect(spendingCapacity(e, M(60), MLS_LEAGUE)).toBe(M(25))
  })

  it('para juzgar la amenaza rival toma su escenario mas rico', () => {
    const incierto = { ...e, exact: false, low: M(5), high: M(20), estimate: M(12.5) }
    expect(spendingCapacity(incierto, M(60), MLS_LEAGUE, 'worst')).toBe(M(35))
    expect(spendingCapacity(incierto, M(60), MLS_LEAGUE, 'best')).toBe(M(20))
  })
})

describe('rangos auxiliares', () => {
  it('sin jornadas jugadas no hay incertidumbre', () => {
    expect(quinielaRange(0, MLS_LEAGUE)).toEqual([0, 0])
    expect(salaryRange(0, M(90), MLS_LEAGUE)).toEqual([0, 0])
  })

  it('con salarios confirmados el rango colapsa', () => {
    const on: LeagueConfig = { ...MLS_LEAGUE, salaries: { ...MLS_LEAGUE.salaries, enabled: true } }
    expect(salaryRange(5, M(90), on)).toEqual([M(-4.5), M(-4.5)])
  })

  it('con salarios sin confirmar el rango va de cero al cargo completo', () => {
    const sinConfirmar: LeagueConfig = {
      ...MLS_LEAGUE,
      salaries: { ...MLS_LEAGUE.salaries, confirmed: false },
    }
    expect(salaryRange(5, M(90), sinConfirmar)).toEqual([M(-4.5), 0])
  })

  it('comprobado que estan apagados, el rango colapsa a cero', () => {
    expect(salaryRange(5, M(90), MLS_LEAGUE)).toEqual([0, 0])
  })
})

describe('intervalos acotados por las reglas, no a bulto', () => {
  const rival = {
    managerId: 5,
    transactions: [tx('purchase', M(-12)), tx('sale', M(4))],
    historyComplete: false,
    teamValue: M(120),
    averageLineupValue: M(80),
    jornadaRanks: [
      { jornada: 1, rank: 3 }, { jornada: 2, rank: 5 },
      { jornada: 3, rank: 2 }, { jornada: 4, rank: 7 },
    ],
    scoredJornadas: [1, 2, 3, 4],
  }

  it('el intervalo es finito y utilizable, no de decenas de millones', () => {
    const e = reconstructBalance(rival, MLS_LEAGUE)
    // Antes se sumaba un margen fijo de 25M a cada lado, un ancho de 50M que
    // tapaba cualquier señal y dejaba a todos los rivales sin clasificar.
    expect(e.high - e.low).toBeLessThan(M(60))
    expect(Number.isFinite(e.low)).toBe(true)
    expect(Number.isFinite(e.high)).toBe(true)
  })

  it('la cota inferior nunca queda por debajo de cero si el rival puntuo', () => {
    const e = reconstructBalance(rival, MLS_LEAGUE)
    expect(e.low).toBeGreaterThanOrEqual(0)
  })

  it('explica que le falta al historial en vez de decir que no lo tiene', () => {
    const e = reconstructBalance(rival, MLS_LEAGUE)
    expect(e.unknowns.join(' ')).toMatch(/modificaciones de clausula/)
  })

  it('sin los puestos por jornada, las bonificaciones vuelven a ser un rango', () => {
    const sinPuestos = { ...rival, jornadaRanks: undefined }
    const e = reconstructBalance(sinPuestos, MLS_LEAGUE)
    expect(e.unknowns.join(' ')).toMatch(/bonificaciones/)
  })

  it('conocer el puesto de cada jornada estrecha el intervalo', () => {
    /**
     * Es la mejora que trae /ajax/sw/progression. La bonificacion depende solo
     * del puesto, asi que con el puesto deja de ser un rango de 1,0M a 1,5M por
     * jornada y pasa a ser una cifra exacta, tambien para los rivales.
     */
    const conPuestos = reconstructBalance(rival, MLS_LEAGUE)
    const sinPuestos = reconstructBalance({ ...rival, jornadaRanks: undefined }, MLS_LEAGUE)
    expect(conPuestos.high - conPuestos.low).toBeLessThan(sinPuestos.high - sinPuestos.low)
  })

  it('no cuenta dos veces la bonificacion cuando se conoce el puesto', () => {
    /**
     * Si se sumara el rango ademas de la cifra exacta, conocer los puestos no
     * estrecharia nada y las dos anchuras serian iguales. Y el ahorro no puede
     * pasar de lo que ocupa ese rango: cuatro jornadas de 1,0 a 1,5M, o sea
     * 2M. Puede quedarse corto porque otras restricciones ya recortan el
     * intervalo por abajo, y por eso se comprueba la cota y no la igualdad.
     */
    const conPuestos = reconstructBalance(rival, MLS_LEAGUE)
    const sinPuestos = reconstructBalance({ ...rival, jornadaRanks: undefined }, MLS_LEAGUE)
    const ahorro = (sinPuestos.high - sinPuestos.low) - (conPuestos.high - conPuestos.low)
    const rango = MLS_LEAGUE.jornadaRankBonus
    expect(ahorro).toBeGreaterThan(0)
    expect(ahorro).toBeLessThanOrEqual((Math.max(...rango) - Math.min(...rango)) * 4)
  })

  it('la regla del reparto deja poco que ganar por conocer el dato exacto', () => {
    /**
     * Antes, no saber la plantilla inicial costaba diecisiete millones y medio
     * de intervalo, porque lo unico que se podia decir era que valia entre el
     * 40% y el 75% del presupuesto. Con la regla del reparto (75% del
     * presupuesto, margen del 2%) ese termino baja a dos millones, asi que
     * declarar el dato exacto ya casi no anade nada.
     */
    const sinDato = reconstructBalance(rival, MLS_LEAGUE)
    const margen = MLS_LEAGUE.initialBudget * MLS_LEAGUE.initialSquadTolerance * 2
    expect(margen).toBeLessThanOrEqual(M(2))

    // Y la incognita sigue declarandose, porque es una regla, no una medida.
    expect(sinDato.unknowns.join(' ')).toMatch(/regla del reparto/)
    const conDato = reconstructBalance({ ...rival, initialSquadValue: M(30) }, MLS_LEAGUE)
    expect(conDato.unknowns.join(' ')).not.toMatch(/regla del reparto/)
  })

  it('un historial completo estrecha mas todavia', () => {
    const parcial = reconstructBalance({ ...rival, initialSquadValue: M(30) }, MLS_LEAGUE)
    const completo = reconstructBalance(
      { ...rival, initialSquadValue: M(30), historyComplete: true },
      MLS_LEAGUE,
    )
    expect(completo.high - completo.low).toBeLessThan(parcial.high - parcial.low)
  })
})

describe('la caja inicial se lee, no se supone', () => {
  /**
   * Mister no reparte 50M de saldo: reparte plantilla y acredita el resto. En
   * la cuenta real ese apunte fue de 12,47M, o sea una plantilla inicial de
   * 37,53M. El modelo suponia 25M de caja, asi que le sobraban doce millones y
   * medio al saldo estimado de cada rival.
   */
  it('saca la caja inicial del apunte de saldo inicial del libro', () => {
    const txs: Transaction[] = [
      tx('seed', M(12.472)),
      tx('bonus', M(1.2)),
      tx('purchase', -M(3)),
    ]
    expect(observedInitialCash(txs)).toBe(M(12.472))
  })

  it('devuelve null si el libro no llega hasta el principio de temporada', () => {
    expect(observedInitialCash([tx('purchase', -M(3))])).toBeNull()
  })

  it('con el apunte en el libro, la caja de partida es dato y no se estima', () => {
    /**
     * Es la regla que evita contar dos veces los mismos doce millones y medio.
     * Si el libro trae el apunte de saldo inicial, la caja de partida la aporta
     * el, y no hay que sumar ademas "presupuesto menos plantilla inicial".
     */
    const e = reconstructBalance(
      {
        managerId: 1,
        historyComplete: true,
        teamValue: M(50),
        averageLineupValue: 0,
        jornadaRanks: [],
        transactions: [tx('seed', M(12.472)), tx('purchase', -M(3)), tx('sale', M(1))],
      },
      DETERMINISTIC,
    )
    expect(e.components.initialCash).toBe(M(12.472))
    expect(e.estimate).toBe(M(12.472) - M(3) + M(1))
    // Y sin nada que suponer sobre la plantilla inicial, el intervalo colapsa.
    expect(e.low).toBe(e.high)
    expect(e.unknowns.join(' ')).not.toMatch(/plantilla repartida/)
  })

  it('la medida propia manda sobre la regla cuando existe', () => {
    const comun = {
      managerId: 2,
      transactions: [] as Transaction[],
      historyComplete: true,
      teamValue: M(50),
    }
    // Sin medida, se aplica la regla: 75% de plantilla, 25% de caja.
    expect(reconstructBalance(comun, MLS_LEAGUE).estimate).toBe(M(12.5))

    // Con la medida propia, ese numero manda, porque incluye el redondeo real
    // de esta liga: la caja observada fueron 12.472.000, no 12.500.000.
    const conMedida = reconstructBalance(
      { ...comun, initialSquadValueHint: M(50) - 12_472_000 },
      MLS_LEAGUE,
    )
    expect(conMedida.estimate).toBe(12_472_000)
  })

  it('el supuesto se declara como tal en las incognitas', () => {
    const est = reconstructBalance(
      { managerId: 2, transactions: [], historyComplete: true, teamValue: M(50),
        initialSquadValueHint: M(37.5) },
      MLS_LEAGUE,
    )
    expect(est.unknowns.join(' ')).toMatch(/regla del reparto/)
    expect(est.exact).toBe(false)
  })

  it('si la solvencia no cuadra con la regla, manda lo observado y se declara', () => {
    /**
     * La regla del reparto se midio una sola vez, y el margen de deuda se
     * modela sobre el valor de equipo de HOY porque el de entonces no se
     * conoce. Cuando la restriccion y la reconstruccion chocan no se sabe cual
     * falla, asi que mandan los datos observados y se avisa.
     *
     * Ensanchar hasta cubrir las dos era peor: devolvia intervalos de veinte
     * millones que no sirven para decidir nada, que es justo lo que se estaba
     * intentando arreglar.
     */
    const imposible = reconstructBalance(
      {
        managerId: 9,
        // Paga 60M teniendo, segun la regla, 12,5M de caja y 10M de margen.
        transactions: [{ ...tx('buyout_signing', -M(60)), date: '2026-08-20T05:00:00Z' }],
        historyComplete: true,
        teamValue: M(40),
        averageLineupValue: M(30),
        jornadaRanks: [],
        clauseRaisesObserved: true,
      },
      MLS_LEAGUE,
    )
    expect(imposible.high).toBeGreaterThanOrEqual(imposible.low)
    expect(imposible.unknowns.join(' ')).toMatch(/solvencia observada no cuadra/)
    // Y el intervalo sigue siendo el de la reconstruccion, no uno inventado.
    const banda = MLS_LEAGUE.initialBudget * MLS_LEAGUE.initialSquadTolerance * 2
    expect(imposible.high - imposible.low).toBeLessThanOrEqual(banda)
  })

  it('un baseline declarado manda sobre el supuesto', () => {
    const est = reconstructBalance(
      { managerId: 2, transactions: [], historyComplete: true, teamValue: M(50),
        initialSquadValue: M(30), initialSquadValueHint: M(37.5) },
      MLS_LEAGUE,
    )
    expect(est.estimate).toBe(M(20))
    expect(est.low).toBe(est.high)
  })
})

describe('las subidas de clausula no se publican en ninguna parte', () => {
  /**
   * El feed publica las BAJADAS, que son un abono, pero no las subidas, que
   * son el gasto. Asi que tener el feed entero no basta: hay que seguir
   * acotando ese gasto con las clausulas que si se ven.
   *
   * Se descubrio reconstruyendo mi propio saldo a ciegas: sobraban 2,38M, que
   * era exactamente lo que decia mi libro de subidas de clausula.
   */
  const base = {
    managerId: 7,
    transactions: [] as Transaction[],
    historyComplete: true,
    teamValue: M(50),
    jornadaRanks: [],
    maxClauseSpend: M(3),
    minClauseSpend: M(1),
  }

  it('las acota aunque el historial este completo', () => {
    const e = reconstructBalance(base, MLS_LEAGUE)
    expect(e.high - e.low).toBeGreaterThanOrEqual(M(2))
    expect(e.unknowns.join(' ')).toMatch(/subidas de clausula/)
  })

  it('no las acota cuando ya vienen en el libro, como en el propio', () => {
    const e = reconstructBalance({ ...base, clauseRaisesObserved: true }, MLS_LEAGUE)
    expect(e.unknowns.join(' ')).not.toMatch(/subidas de clausula/)
    // Quitado ese termino y con el historial completo, lo unico que queda es
    // la banda de la plantilla inicial: el 2% del presupuesto a cada lado.
    const banda = MLS_LEAGUE.initialBudget * MLS_LEAGUE.initialSquadTolerance * 2
    expect(e.high - e.low).toBe(banda)
  })

  it('el suelo del gasto estrecha el intervalo por arriba', () => {
    const sinSuelo = reconstructBalance({ ...base, minClauseSpend: 0 }, MLS_LEAGUE)
    const conSuelo = reconstructBalance(base, MLS_LEAGUE)
    expect(conSuelo.high).toBeLessThan(sinSuelo.high)
    expect(conSuelo.low).toBe(sinSuelo.low)
  })
})
