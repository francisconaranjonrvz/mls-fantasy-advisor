import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type OwnedPlayer, type Player, type Position } from '@mls/core'
import { buildValuationContext } from './valuation.ts'
import {
  optimizeLineup, bestLineupFor, expectedJornadaPoints, bestSubstitution, FORMATIONS,
} from './lineup.ts'

const CATALOG: Player[] = Array.from({ length: 21 }, (_, i) => ({
  id: 1000 + i, name: `J${i}`, position: 'MF' as const, hasTeam: true,
  status: 'ok' as const, value: M(10), points: 10,
}))
const CTX = buildValuationContext(CATALOG, 10, 38)

let nextId = 1
const p = (position: Position, points: number, over: Partial<OwnedPlayer> = {}): OwnedPlayer => ({
  id: nextId++, name: `${position}${points}`, position, hasTeam: true, status: 'ok',
  value: M(5), points, ownerId: 1, onMarket: false, ...over,
})

/** Plantilla holgada: sobran jugadores en todas las posiciones. */
const squadCompleta = (): OwnedPlayer[] => {
  nextId = 1
  return [
    p('GK', 40), p('GK', 20),
    p('DF', 50), p('DF', 45), p('DF', 40), p('DF', 35), p('DF', 30), p('DF', 10),
    p('MF', 60), p('MF', 55), p('MF', 50), p('MF', 45), p('MF', 40), p('MF', 15),
    p('FW', 70), p('FW', 65), p('FW', 30), p('FW', 12),
  ]
}

describe('puntos esperados por jornada', () => {
  it('un jugador sin equipo en LaLiga no puntua, por bueno que fuera', () => {
    expect(expectedJornadaPoints(p('FW', 80, { hasTeam: false }), CTX)).toBe(0)
  })

  it('un lesionado no puntua esta jornada', () => {
    expect(expectedJornadaPoints(p('FW', 80, { status: 'injured' }), CTX)).toBe(0)
  })

  it('un sancionado tampoco', () => {
    expect(expectedJornadaPoints(p('MF', 50, { status: 'sanctioned' }), CTX)).toBe(0)
  })

  it('una duda se penaliza pero no se anula', () => {
    const sano = expectedJornadaPoints(p('MF', 50), CTX)
    const duda = expectedJornadaPoints(p('MF', 50, { status: 'doubt' }), CTX)
    expect(duda).toBeGreaterThan(0)
    expect(duda).toBeLessThan(sano)
  })
})

describe('optimizacion del once', () => {
  it('alinea 11 jugadores y siempre exactamente un portero', () => {
    const { best } = optimizeLineup(squadCompleta(), CTX, MLS_LEAGUE)
    expect(best.slots).toHaveLength(11)
    expect(best.slots.filter((s) => s.position === 'GK')).toHaveLength(1)
  })

  it('elige la formacion que maximiza los puntos esperados', () => {
    const { best, alternatives } = optimizeLineup(squadCompleta(), CTX, MLS_LEAGUE)
    for (const alt of alternatives) {
      expect(best.expectedPoints).toBeGreaterThanOrEqual(alt.expectedPoints)
    }
  })

  it('con delanteros muy superiores, prefiere un dibujo con tres arriba', () => {
    nextId = 1
    const squad = [
      p('GK', 30),
      p('DF', 10), p('DF', 10), p('DF', 10), p('DF', 10), p('DF', 10),
      p('MF', 10), p('MF', 10), p('MF', 10), p('MF', 10), p('MF', 10),
      p('FW', 90), p('FW', 90), p('FW', 90),
    ]
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    expect(best.formation.FW).toBe(3)
  })

  it('no repite jugador en dos huecos', () => {
    const { best } = optimizeLineup(squadCompleta(), CTX, MLS_LEAGUE)
    const ids = best.slots.map((s) => s.player?.id).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('el banquillo son exactamente los no alineados', () => {
    const squad = squadCompleta()
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    expect(best.bench).toHaveLength(squad.length - 11)
  })

  it('para una formacion dada, coger los mejores por posicion es optimo', () => {
    const plan = bestLineupFor(squadCompleta(), FORMATIONS[3]!, CTX, MLS_LEAGUE)
    for (const pos of ['GK', 'DF', 'MF', 'FW'] as const) {
      const titulares = plan.slots.filter((s) => s.position === pos).map((s) => s.expectedPoints)
      const suplentes = plan.bench
        .filter((b) => b.position === pos)
        .map((b) => expectedJornadaPoints(b, CTX))
      if (titulares.length && suplentes.length) {
        expect(Math.min(...titulares)).toBeGreaterThanOrEqual(Math.max(...suplentes))
      }
    }
  })
})

describe('huecos vacios', () => {
  it('penaliza cada hueco que no se puede cubrir', () => {
    nextId = 1
    const squad = [p('GK', 30), p('DF', 20), p('MF', 20), p('FW', 20)]
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    expect(best.emptySlots).toBe(7)
    expect(best.penalty).toBe(7 * MLS_LEAGUE.emptySlotPenalty)
  })

  it('la penalizacion se descuenta de los puntos esperados', () => {
    nextId = 1
    const squad = [p('GK', 30), p('DF', 20)]
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    const bruto = best.slots.reduce((a, s) => a + s.expectedPoints, 0)
    expect(best.expectedPoints).toBe(bruto + best.penalty)
    expect(best.expectedPoints).toBeLessThan(bruto)
  })

  it('prefiere el dibujo que deja menos huecos cuando falta gente arriba', () => {
    nextId = 1
    const squad = [
      p('GK', 30),
      p('DF', 20), p('DF', 20), p('DF', 20), p('DF', 20), p('DF', 20),
      p('MF', 20), p('MF', 20), p('MF', 20), p('MF', 20), p('MF', 20),
      p('FW', 20),
    ]
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    expect(best.emptySlots).toBe(0)
    expect(best.formation.FW).toBe(1)
  })
})

describe('el unico cambio permitido durante la jornada', () => {
  it('no propone nada si el once ya es el mejor posible', () => {
    const { best } = optimizeLineup(squadCompleta(), CTX, MLS_LEAGUE)
    expect(bestSubstitution(best, CTX)).toBeNull()
  })

  it('sin banquillo no hay recambio que proponer', () => {
    nextId = 1
    const squad = [p('GK', 30), p('DF', 20), p('MF', 20), p('FW', 20)]
    const { best } = optimizeLineup(squad, CTX, MLS_LEAGUE)
    expect(best.emptySlots).toBeGreaterThan(0)
    expect(bestSubstitution(best, CTX)).toBeNull()
  })

  it('no alinea a un lesionado habiendo un suplente sano en su posicion', () => {
    nextId = 1
    const squad = [
      p('GK', 30),
      p('DF', 20), p('DF', 20), p('DF', 20), p('DF', 20),
      p('MF', 20), p('MF', 20), p('MF', 20), p('MF', 20),
      p('FW', 90, { status: 'injured' }), p('FW', 20), p('FW', 50),
    ]
    const plan = bestLineupFor(squad, { name: '4-4-2', DF: 4, MF: 4, FW: 2 }, CTX, MLS_LEAGUE)
    expect(plan.slots.map((s) => s.player?.name)).not.toContain('FW90')
  })
})
