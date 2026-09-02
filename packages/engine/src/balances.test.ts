import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type Transaction, type LeagueConfig } from '@mls/core'
import {
  reconstructBalance, bonusesFromRanks, quinielaRange, salaryRange,
  calibrate, exactBalance, spendingCapacity,
} from './balances.js'

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

  it('la quiniela y los salarios abren el intervalo', () => {
    const e = reconstructBalance(base, MLS_LEAGUE)
    expect(e.high).toBeGreaterThan(e.low)
    expect(e.unknowns.join(' ')).toMatch(/quiniela/)
    expect(e.unknowns.join(' ')).toMatch(/salarios/)
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

  it('un desembolso grande demuestra un suelo de saldo', () => {
    const e = reconstructBalance(
      {
        managerId: 4,
        historyComplete: false,
        teamValue: M(40),        // margen de deuda = 10M
        averageLineupValue: M(30),
        transactions: [tx('buyout_signing', M(-30))],
      },
      MLS_LEAGUE,
    )
    // Pago 30M con 10M de margen => tenia al menos 20M de saldo.
    expect(e.low).toBeGreaterThanOrEqual(M(20))
    expect(e.constraintsApplied.join(' ')).toMatch(/margen de deuda/)
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
    expect(salaryRange(5, M(90), MLS_LEAGUE)).toEqual([M(-4.5), 0])
  })
})
