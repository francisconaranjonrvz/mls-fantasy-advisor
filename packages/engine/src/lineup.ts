import type { OwnedPlayer, Position, LeagueConfig } from '@mls/core'
import { pointsPerJornada, type ValuationContext } from './valuation.ts'

/**
 * Eleccion del once.
 *
 * Mister permite un conjunto cerrado de formaciones, y dentro de cada una la
 * unica restriccion es cuantos jugadores caben por posicion. Eso tiene una
 * consecuencia util: para una formacion dada, coger los mejores de cada
 * posicion es OPTIMO, no una aproximacion, porque las posiciones no compiten
 * entre si. Y como el catalogo de formaciones es pequeno, enumerarlas todas y
 * quedarse con la mejor da el optimo global.
 *
 * Dicho de otro modo: aqui no hace falta un solver. Un solver sugeriria que el
 * problema es mas dificil de lo que es.
 */

export interface Formation {
  name: string
  DF: number
  MF: number
  FW: number
}

/** Formaciones que admite Mister. Siempre un portero. */
export const FORMATIONS: readonly Formation[] = [
  { name: '3-4-3', DF: 3, MF: 4, FW: 3 },
  { name: '3-5-2', DF: 3, MF: 5, FW: 2 },
  { name: '4-3-3', DF: 4, MF: 3, FW: 3 },
  { name: '4-4-2', DF: 4, MF: 4, FW: 2 },
  { name: '4-5-1', DF: 4, MF: 5, FW: 1 },
  { name: '5-3-2', DF: 5, MF: 3, FW: 2 },
  { name: '5-4-1', DF: 5, MF: 4, FW: 1 },
] as const

/**
 * Puntos esperados de un jugador en UNA jornada.
 *
 * Se separa del valor deportivo a proposito: aquel mide lo que aporta en lo que
 * queda de temporada y sirve para decidir fichajes; este mide el sabado que
 * viene y sirve para decidir la alineacion.
 */
export function expectedJornadaPoints(player: OwnedPlayer, ctx: ValuationContext): number {
  // Sin equipo en LaLiga no hay partido que jugar, asi que no hay puntos.
  if (!player.hasTeam) return 0
  const base = pointsPerJornada(player, ctx)
  const availability =
    player.status === 'injured' ? 0
    : player.status === 'sanctioned' ? 0
    : player.status === 'doubt' ? 0.6
    : 1
  return base * availability
}

export interface LineupSlot {
  position: Position
  player: OwnedPlayer | null
  expectedPoints: number
}

export interface LineupPlan {
  formation: Formation
  slots: LineupSlot[]
  /** Puntos esperados del once, ya descontadas las penalizaciones por hueco. */
  expectedPoints: number
  /** Huecos que no se han podido cubrir. Cada uno resta. */
  emptySlots: number
  penalty: number
  bench: OwnedPlayer[]
}

const byPosition = (squad: OwnedPlayer[], pos: Position, ctx: ValuationContext): OwnedPlayer[] =>
  squad
    .filter((p) => p.position === pos)
    .sort((a, b) => expectedJornadaPoints(b, ctx) - expectedJornadaPoints(a, ctx))

/** Mejor once posible para una formacion concreta. */
export function bestLineupFor(
  squad: OwnedPlayer[],
  formation: Formation,
  ctx: ValuationContext,
  config: LeagueConfig,
): LineupPlan {
  const need: [Position, number][] = [
    ['GK', 1],
    ['DF', formation.DF],
    ['MF', formation.MF],
    ['FW', formation.FW],
  ]

  const slots: LineupSlot[] = []
  const chosen = new Set<number>()

  for (const [pos, count] of need) {
    const candidates = byPosition(squad, pos, ctx)
    for (let i = 0; i < count; i++) {
      const player = candidates[i] ?? null
      if (player) chosen.add(player.id)
      slots.push({
        position: pos,
        player,
        expectedPoints: player ? expectedJornadaPoints(player, ctx) : 0,
      })
    }
  }

  const emptySlots = slots.filter((s) => s.player === null).length
  const penalty = emptySlots * config.emptySlotPenalty
  const raw = slots.reduce((acc, s) => acc + s.expectedPoints, 0)

  return {
    formation,
    slots,
    expectedPoints: raw + penalty,
    emptySlots,
    penalty,
    bench: squad
      .filter((p) => !chosen.has(p.id))
      .sort((a, b) => expectedJornadaPoints(b, ctx) - expectedJornadaPoints(a, ctx)),
  }
}

/**
 * Mejor once entre todas las formaciones posibles.
 *
 * Al enumerarlas todas y ser cada una optima por construccion, el resultado es
 * el optimo global. Se devuelven tambien las alternativas para poder ver cuanto
 * se pierde por cambiar de dibujo.
 */
export function optimizeLineup(
  squad: OwnedPlayer[],
  ctx: ValuationContext,
  config: LeagueConfig,
): { best: LineupPlan; alternatives: LineupPlan[] } {
  const plans = FORMATIONS.map((f) => bestLineupFor(squad, f, ctx, config)).sort(
    (a, b) => b.expectedPoints - a.expectedPoints,
  )
  return { best: plans[0]!, alternatives: plans.slice(1) }
}

export interface SubstitutionAdvice {
  out: OwnedPlayer
  in: OwnedPlayer
  gain: number
  rationale: string
}

/**
 * El unico cambio que permite el reglamento de la liga durante la jornada.
 *
 * Las condiciones son estrictas: el que sale debe estar en el once y no haber
 * disputado aun su partido, y el que entra tampoco puede haberlo jugado y tenia
 * que estar ya en el equipo antes de empezar la jornada. Como esta funcion no
 * sabe que partidos se han jugado, devuelve el mejor candidato SUJETO A que se
 * cumplan esas condiciones, y lo dice.
 */
export function bestSubstitution(
  plan: LineupPlan,
  ctx: ValuationContext,
): SubstitutionAdvice | null {
  let best: SubstitutionAdvice | null = null

  for (const slot of plan.slots) {
    const candidates = plan.bench.filter((b) => b.position === slot.position)
    for (const candidate of candidates) {
      const gain = expectedJornadaPoints(candidate, ctx) - slot.expectedPoints
      if (gain <= 0) continue
      if (!best || gain > best.gain) {
        best = {
          out: slot.player ?? candidate,
          in: candidate,
          gain,
          rationale: slot.player
            ? `${candidate.name} rinde mas que ${slot.player.name} en esa posicion.`
            : `Cubre un hueco vacio, que de lo contrario resta ${Math.abs(plan.penalty)} puntos.`,
        }
      }
    }
  }

  return best
}
