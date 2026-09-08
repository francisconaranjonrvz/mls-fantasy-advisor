import { describe, it, expect } from 'vitest'
import { M, type Player } from '@mls/core'
import {
  buildValuationContext, observedPointsPerJornada, expectedPointsPerJornada,
  streakCoversSeason, expectedRemainingPoints,
} from './valuation.ts'

/**
 * Catalogo de referencia: gente que juega todas las jornadas y puntua igual.
 * Fija la media de cada posicion sin ruido, para que lo que se mida aqui sea
 * el efecto de la racha y no el del prior.
 */
const CATALOG: Player[] = Array.from({ length: 40 }, (_, i) => ({
  id: 1000 + i,
  name: `Jugador ${i}`,
  position: (['GK', 'DF', 'MF', 'FW'] as const)[i % 4]!,
  hasTeam: true,
  status: 'ok' as const,
  value: M(10),
  points: 8,
  streak: [2, 2, 2, 2],
  average: 2,
}))

const CTX = buildValuationContext(CATALOG, 4, 38)

const jugador = (over: Partial<Player>): Player => ({
  id: 1, name: 'X', position: 'GK', hasTeam: true, status: 'ok',
  value: M(1), points: 0, ...over,
})

describe('las jornadas sin jugar cuentan como cero', () => {
  /**
   * El fallo que motiva este fichero. Unai Marrero, portero de 228.000, jugo
   * un partido de cuatro y puntuo 11. Con los huecos descartados su racha era
   * [11] y el modelo leia "once puntos por jornada", asi que lo proyectaba por
   * encima de un portero de 9.901.000 y recomendaba pagar su clausula.
   *
   * Contra el catalogo real el hueco es inequivocamente "no jugo": las
   * entradas numericas coinciden con las apariciones que declara Mister en 394
   * de 397 casos.
   */
  it('once puntos en un partido de cuatro no son once por jornada', () => {
    const suplente = jugador({ points: 11, streak: [0, 11, 0, 0] })
    const proyeccion = observedPointsPerJornada(suplente, CTX)!

    // Antes salia exactamente 11, que es su media POR PARTIDO JUGADO. Ahora
    // ronda la media por jornada disputada, 11/4 = 2,75, y el resto es la
    // ponderacion por recencia, que aqui le favorece porque el partido bueno
    // es el ultimo.
    expect(proyeccion).toBeGreaterThan(2.5)
    expect(proyeccion).toBeLessThan(3.5)
  })

  it('el que reparte sus puntos gana al que los hizo en un partido lejano', () => {
    // Mismos 11 puntos. El regular los tiene repartidos; el otro los hizo en
    // la jornada mas antigua de la ventana y no ha vuelto a jugar.
    const regular = jugador({ points: 11, streak: [3, 3, 3, 2] })
    const unPartido = jugador({ points: 11, streak: [0, 0, 0, 11] })

    expect(observedPointsPerJornada(regular, CTX)!)
      .toBeGreaterThan(observedPointsPerJornada(unPartido, CTX)!)
  })

  it('la proyeccion se queda dentro de lo que el jugador ha hecho', () => {
    // Una media ponderada no puede salirse del rango de sus datos. Con los
    // huecos descartados si se salia: la racha se quedaba sin los ceros y la
    // media subia por encima de todo lo observado por jornada.
    for (const streak of [[0, 11, 0, 0], [0, 0, 0, 8], [6, 0, 0], [5, 5, 0, 0]]) {
      const p = jugador({ points: streak.reduce((a, b) => a + b, 0), streak })
      const proyeccion = observedPointsPerJornada(p, CTX)!
      expect(proyeccion).toBeGreaterThanOrEqual(Math.min(...streak))
      expect(proyeccion).toBeLessThanOrEqual(Math.max(...streak))
      // Y muy por debajo de su media por partido jugado, que es lo que se
      // estaba usando por error.
      const porPartidoJugado = p.points / streak.filter((x) => x > 0).length
      expect(proyeccion).toBeLessThan(porPartidoJugado)
    }
  })

  it('el que no ha jugado ni un minuto no hereda la media de su posicion', () => {
    const nunca = jugador({ points: 0, streak: [0, 0, 0, 0] })
    expect(expectedPointsPerJornada(nunca, CTX)).toBe(0)
    expect(expectedRemainingPoints(nunca, CTX)).toBe(0)
  })
})

describe('rachas que no cubren la temporada', () => {
  /**
   * Tres jugadores del catalogo real tienen una racha que no suma sus puntos,
   * y todos han cambiado de club: la ventana solo trae lo del club actual.
   * Fiarse de ella los hundiria, asi que ahi se vuelve a la media por jornada.
   */
  it('reconoce cuando la racha da cuenta de todos los puntos', () => {
    expect(streakCoversSeason(jugador({ points: 11, streak: [0, 11, 0, 0] }))).toBe(true)
    // Pablo Garcia: 25 puntos, pero su racha solo recoge 11.
    expect(streakCoversSeason(jugador({ points: 25, streak: [0, 0, 0, 11] }))).toBe(false)
    expect(streakCoversSeason(jugador({ points: 15 }))).toBe(false)
  })

  it('si la racha no cuadra, manda la media por jornada', () => {
    const cambioDeClub = jugador({ points: 25, streak: [0, 0, 0, 11] })
    // 25 puntos en 4 jornadas son 6,25, no los 11 de su unico partido visible
    // ni los 2,75 que saldrian de ponderar una racha incompleta.
    expect(observedPointsPerJornada(cambioDeClub, CTX)).toBeCloseTo(25 / 4, 6)
  })
})
