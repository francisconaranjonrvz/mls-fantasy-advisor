import { describe, it, expect } from 'vitest'
import { MLS_CONTRACT, THEORETICAL_POT } from '@mls/core'
import {
  computeLedger, prizeDistribution, effectivePoints, paymentDeadline, monthlyBreakdown,
  type JornadaOutcome,
} from './contract.ts'

const MANAGERS = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `M${i + 1}` }))

const jornadas = (n: number, winner: (j: number) => number): JornadaOutcome[] =>
  Array.from({ length: n }, (_, i) => ({ jornada: i + 1, winnerId: winner(i + 1) }))

describe('el ganador de jornada no paga', () => {
  it('quien gana una jornada se ahorra ese euro', () => {
    const { accounts } = computeLedger(MANAGERS, jornadas(5, () => 1))
    const ganador = accounts.find((a) => a.managerId === 1)!
    const resto = accounts.find((a) => a.managerId === 2)!
    expect(ganador.jornadasWon).toBe(5)
    expect(ganador.owed).toBe(0)
    expect(ganador.saved).toBe(5)
    expect(resto.owed).toBe(5)
  })

  it('el bote de una jornada son 9 euros, no 10', () => {
    const { pot } = computeLedger(MANAGERS, jornadas(1, () => 1))
    expect(pot).toBe(9)
  })
})

describe('bote de la temporada completa', () => {
  it('las 38 jornadas dan 342 euros, que es la cifra del contrato', () => {
    const { pot } = computeLedger(MANAGERS, jornadas(38, (j) => (j % 10) + 1))
    expect(pot).toBe(342)
    expect(pot).toBe(THEORETICAL_POT)
  })

  it('la proyeccion a mitad de temporada tambien llega a 342', () => {
    const { projectedPot } = computeLedger(MANAGERS, jornadas(19, (j) => (j % 10) + 1))
    expect(projectedPot).toBe(342)
  })

  it('sin jornadas disputadas, la proyeccion sigue siendo 342', () => {
    expect(computeLedger(MANAGERS, []).projectedPot).toBe(342)
  })
})

describe('reparto del bote', () => {
  it('60 / 25 / 15 sobre 342 euros', () => {
    expect(prizeDistribution(342)).toEqual([205.2, 85.5, 51.3])
  })

  it('el reparto suma el bote entero', () => {
    const [a, b, c] = prizeDistribution(342)
    expect(Math.round((a + b + c) * 100) / 100).toBe(342)
  })
})

describe('puntuacion efectiva', () => {
  it('descuenta las sanciones del reglamento', () => {
    // 2 puntos por incumplir la norma del cambio unico.
    expect(effectivePoints(312, MLS_CONTRACT.illegalSubPenalty)).toBe(310)
  })

  it('sin sanciones coincide con lo que muestra Mister', () => {
    expect(effectivePoints(312)).toBe(312)
  })
})

describe('plazos de pago', () => {
  it('una jornada de septiembre se paga antes del 5 de octubre', () => {
    const { month, deadline } = paymentDeadline(new Date('2026-09-14T21:00:00Z'))
    expect(month).toBe('2026-09')
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-10-05')
  })

  it('una jornada de diciembre se paga en enero del ano siguiente', () => {
    const { deadline } = paymentDeadline(new Date('2026-12-28T21:00:00Z'))
    expect(deadline.toISOString().slice(0, 10)).toBe('2027-01-05')
  })

  it('cuenta el mes en que EMPIEZA la jornada, como dice el contrato', () => {
    // Jornada que arranca el 30 de septiembre aunque termine en octubre.
    expect(paymentDeadline(new Date('2026-09-30T19:00:00Z')).month).toBe('2026-09')
  })
})

describe('desglose mensual', () => {
  const outcomes: JornadaOutcome[] = [
    { jornada: 1, winnerId: 1, startedAt: '2026-09-05T19:00:00Z' },
    { jornada: 2, winnerId: 2, startedAt: '2026-09-12T19:00:00Z' },
    { jornada: 3, winnerId: 1, startedAt: '2026-10-03T19:00:00Z' },
  ]

  it('agrupa por mes y ordena cronologicamente', () => {
    const meses = monthlyBreakdown(MANAGERS, outcomes)
    expect(meses.map((m) => m.month)).toEqual(['2026-09', '2026-10'])
  })

  it('descuenta las exenciones dentro de cada mes', () => {
    const [septiembre, octubre] = monthlyBreakdown(MANAGERS, outcomes)
    // En septiembre hay 2 jornadas y el manager 1 gano una: paga 1 de 2.
    expect(septiembre!.owedByManager[1]).toBe(1)
    expect(septiembre!.owedByManager[3]).toBe(2)
    // En octubre hay 1 jornada y la gano el manager 1: no paga nada.
    expect(octubre!.owedByManager[1]).toBe(0)
    expect(octubre!.owedByManager[3]).toBe(1)
  })

  it('ignora jornadas sin fecha en vez de inventarse un mes', () => {
    const meses = monthlyBreakdown(MANAGERS, [{ jornada: 9, winnerId: 1 }])
    expect(meses).toHaveLength(0)
  })
})
