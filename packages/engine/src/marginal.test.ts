import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type OwnedPlayer, type Player, type Position } from '@mls/core'
import { buildValuationContext } from './valuation.ts'
import { marginalGain, costPerPoint, marketBenchmark } from './marginal.ts'

/**
 * Catalogo de referencia: 40 jugadores repartidos por posicion, todos a 10M y
 * 1 punto por jornada. Fija el precio del punto y la media de cada posicion.
 */
const CATALOG: Player[] = Array.from({ length: 40 }, (_, i) => ({
  id: 1000 + i,
  name: `Jugador ${i}`,
  position: (['GK', 'DF', 'MF', 'FW'] as const)[i % 4]!,
  hasTeam: true,
  status: 'ok' as const,
  value: M(10),
  points: 10,
}))

// 10 jornadas jugadas de 38 => quedan 28.
const CTX = buildValuationContext(CATALOG, 10, 38)

let siguienteId = 1
const jugador = (position: Position, points: number, over: Partial<OwnedPlayer> = {}): OwnedPlayer => ({
  id: siguienteId++,
  name: `${position}-${points}`,
  position,
  hasTeam: true,
  status: 'ok',
  value: M(10),
  points,
  ownerId: 1,
  onMarket: false,
  ...over,
})

/** Plantilla completa y equilibrada: 1 GK, 5 DF, 5 MF, 3 FW, todos mediocres. */
const plantillaBase = (): OwnedPlayer[] => [
  jugador('GK', 10),
  ...Array.from({ length: 5 }, () => jugador('DF', 10)),
  ...Array.from({ length: 5 }, () => jugador('MF', 10)),
  ...Array.from({ length: 3 }, () => jugador('FW', 10)),
]

describe('lo que aporta un fichaje es lo que mejora el once, no lo que puntua', () => {
  it('un crack solo aporta la diferencia con el titular al que desplaza', () => {
    const squad = plantillaBase()
    // 30 puntos en 10 jornadas frente a los 10 del resto.
    const crack = jugador('MF', 30, { ownerId: 2 })

    const gain = marginalGain(crack, squad, CTX, MLS_LEAGUE)

    expect(gain.entersLineup).toBe(true)
    expect(gain.displaces).toBeDefined()
    expect(gain.displaces!.position).toBe('MF')

    // Su proyeccion propia es de 2,43 puntos por jornada; el desplazado da 1.
    // Lo que aporta es la diferencia, no su cifra entera.
    expect(gain.perJornada).toBeGreaterThan(1.2)
    expect(gain.perJornada).toBeLessThan(1.6)
  })

  it('el mismo crack aporta mucho menos si su posicion ya esta bien cubierta', () => {
    const flojo = plantillaBase()
    const fuerte = plantillaBase().map((p) =>
      p.position === 'MF' ? { ...p, points: 28 } : p,
    )
    const crack = jugador('MF', 30, { ownerId: 2 })

    const enFlojo = marginalGain(crack, flojo, CTX, MLS_LEAGUE)
    const enFuerte = marginalGain(crack, fuerte, CTX, MLS_LEAGUE)

    // Es exactamente el mismo jugador. Lo que cambia es a quien desplaza.
    expect(enFuerte.perJornada).toBeLessThan(enFlojo.perJornada)
  })

  it('no aporta nada quien ni entra en el once', () => {
    const squad = plantillaBase()
    const suplente = jugador('MF', 2, { ownerId: 2 })

    const gain = marginalGain(suplente, squad, CTX, MLS_LEAGUE)

    expect(gain.entersLineup).toBe(false)
    expect(gain.perJornada).toBe(0)
    expect(gain.remaining).toBe(0)
  })

  it('un mediocre en la posicion en la que estas cojo vale mas que un crack donde vas sobrado', () => {
    // Este es el resultado que el modelo anterior no podia dar: valoraba a
    // cada jugador por su cuenta, asi que el crack ganaba siempre.
    const cojo = plantillaBase().filter((p) => p.position !== 'GK')
    const mediocrePortero = jugador('GK', 12, { ownerId: 2 })
    const crackMedio = jugador('MF', 30, { ownerId: 2 })

    const portero = marginalGain(mediocrePortero, cojo, CTX, MLS_LEAGUE)
    const medio = marginalGain(crackMedio, cojo, CTX, MLS_LEAGUE)

    expect(portero.perJornada).toBeGreaterThan(medio.perJornada)
  })
})

describe('coste por punto', () => {
  it('un fichaje que no mejora el once no tiene precio que lo justifique', () => {
    const squad = plantillaBase()
    const suplente = jugador('MF', 2, { ownerId: 2 })
    const cpp = costPerPoint(M(1), marginalGain(suplente, squad, CTX, MLS_LEAGUE))
    expect(cpp).toBe(Number.POSITIVE_INFINITY)
  })

  it('ordena bien dos opciones que no se parecen en nada', () => {
    const squad = plantillaBase()
    const caroYBueno = jugador('MF', 30, { ownerId: 2 })
    const baratoYRegular = jugador('MF', 16, { ownerId: 2 })

    const a = costPerPoint(M(40), marginalGain(caroYBueno, squad, CTX, MLS_LEAGUE))
    const b = costPerPoint(M(4), marginalGain(baratoYRegular, squad, CTX, MLS_LEAGUE))

    // El bueno aporta mas puntos, pero el barato los da mucho mas baratos.
    expect(b).toBeLessThan(a)
  })
})

describe('referencia del mercado abierto', () => {
  it('devuelve la oferta que da el punto mas barato', () => {
    const squad = plantillaBase()
    const caro = jugador('MF', 30, { ownerId: 0 })
    const barato = jugador('MF', 20, { ownerId: 0 })

    const ref = marketBenchmark(
      [{ player: caro, price: M(40) }, { player: barato, price: M(5) }],
      squad, CTX, MLS_LEAGUE, M(50),
    )

    expect(ref.player?.id).toBe(barato.id)
    expect(ref.costPerPoint).toBeLessThan(M(1))
  })

  it('ignora lo que no puedes pagar', () => {
    const squad = plantillaBase()
    const inalcanzable = jugador('MF', 30, { ownerId: 0 })

    const ref = marketBenchmark(
      [{ player: inalcanzable, price: M(40) }],
      squad, CTX, MLS_LEAGUE, M(10),
    )

    expect(ref.costPerPoint).toBe(Number.POSITIVE_INFINITY)
    expect(ref.player).toBeUndefined()
  })

  it('sin mercado devuelve infinito, que es lo honesto: no hay alternativa', () => {
    const ref = marketBenchmark([], plantillaBase(), CTX, MLS_LEAGUE, M(50))
    expect(ref.costPerPoint).toBe(Number.POSITIVE_INFINITY)
  })
})
