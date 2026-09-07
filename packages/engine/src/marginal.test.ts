import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type OwnedPlayer, type Player, type Position } from '@mls/core'
import { buildValuationContext, expectedRemainingPoints } from './valuation.ts'
import { marginalGain, costPerPoint, marketBenchmark } from './marginal.ts'
import { optimizeLineup } from './lineup.ts'

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

  it('tapar un hueco urge, pero eso no sube el precio del jugador', () => {
    /**
     * La distincion que faltaba, y por cuya ausencia se colo el fallo.
     *
     * Con la plantilla sin portero, un portero mediocre cierra un agujero que
     * cuesta 4 puntos por jornada, y en la proxima jornada vale mas que
     * cualquier otra cosa. Pero lo que APORTA como jugador sigue siendo lo
     * poco que puntua, y es eso y no la urgencia lo que decide cuanto se le
     * puede pagar. El agujero lo tapa igual el portero mas barato del mercado.
     *
     * Antes las dos cifras iban sumadas en una sola, asi que la urgencia se
     * cobraba como si fuera calidad, y ademas durante las 28 jornadas que
     * quedan en vez de durante la que viene.
     */
    const cojo = plantillaBase().filter((p) => p.position !== 'GK')
    const mediocrePortero = jugador('GK', 12, { ownerId: 2 })
    const crackMedio = jugador('MF', 30, { ownerId: 2 })

    const portero = marginalGain(mediocrePortero, cojo, CTX, MLS_LEAGUE)
    const medio = marginalGain(crackMedio, cojo, CTX, MLS_LEAGUE)

    // Como jugador aporta menos: es peor y el crack tambien entra en el once.
    expect(portero.perJornada).toBeLessThan(medio.perJornada)
    // Pero es el unico que cierra el agujero, y eso vale 4 puntos por jornada.
    expect(portero.gapRelief).toBe(Math.abs(MLS_LEAGUE.emptySlotPenalty))
    expect(medio.gapRelief).toBe(0)
    // Y ese alivio NO se capitaliza: no entra en los puntos de la temporada.
    expect(portero.remaining).toBeCloseTo(portero.perJornada * CTX.jornadasRemaining, 6)
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

describe('la penalizacion por hueco no es merito del fichaje', () => {
  /**
   * El fallo que motiva estas pruebas: `marginalGain` restaba dos onces con la
   * penalizacion por hueco ya descontada, asi que a quien tapaba un hueco se le
   * atribuian sus puntos MAS los 4 de la penalizacion evitada, multiplicados
   * ademas por todas las jornadas que quedan.
   *
   * En la liga real eso eran 128 puntos, unos 3,97 millones, sumados por igual
   * al beneficio del robo de los catorce jugadores de la plantilla. Como ese
   * beneficio se queda con el rival al que mas le compensa, y dos rivales
   * tenian solo diez jugadores, mandaba siempre uno de ellos y toda la
   * plantilla salia en riesgo alto. Con ese numero delante se recomendaba subir
   * clausulas por mas de dos millones de euros.
   *
   * Era invisible comparando jugadores entre si, porque el sesgo era identico
   * para todos. Solo se ve contrastando la ganancia con lo que el jugador puede
   * dar, y de eso va la primera prueba.
   */

  /** Diez jugadores: no llegan a once, asi que siempre queda un hueco. */
  const plantillaCorta = (): OwnedPlayer[] => [
    jugador('GK', 10),
    ...Array.from({ length: 4 }, () => jugador('DF', 10)),
    ...Array.from({ length: 3 }, () => jugador('MF', 10)),
    ...Array.from({ length: 2 }, () => jugador('FW', 10)),
  ]

  it('un fichaje nunca aporta mas puntos de los que el mismo puede dar', () => {
    // La invariante que faltaba. Un once es una suma de jugadores: nadie puede
    // sumar mas de lo que puntua, porque no mejora a los demas.
    const corta = plantillaCorta()
    expect(optimizeLineup(corta, CTX, MLS_LEAGUE).best.emptySlots).toBeGreaterThan(0)

    for (const pos of ['DF', 'MF', 'FW'] as const) {
      const fichaje = jugador(pos, 10)
      const gain = marginalGain(fichaje, corta, CTX, MLS_LEAGUE)
      const suyos = expectedRemainingPoints(fichaje, CTX)
      expect(gain.remaining).toBeLessThanOrEqual(suyos + 1e-9)
    }
  })

  it('tapar un hueco vale exactamente lo que puntua quien lo tapa', () => {
    const corta = plantillaCorta()
    // Un centrocampista entra en el hueco sin desplazar a nadie.
    const fichaje = jugador('MF', 10)
    const gain = marginalGain(fichaje, corta, CTX, MLS_LEAGUE)

    expect(gain.entersLineup).toBe(true)
    expect(gain.displaces).toBeUndefined()
    expect(gain.remaining).toBeCloseTo(expectedRemainingPoints(fichaje, CTX), 6)
  })

  it('el hueco no infla a un jugador flojo por encima de uno bueno', () => {
    // Con el fallo, los 4 puntos de penalizacion evitada se sumaban igual al
    // flojo que al bueno, asi que la diferencia entre ambos se diluia.
    const corta = plantillaCorta()
    const flojo = marginalGain(jugador('MF', 2), corta, CTX, MLS_LEAGUE)
    const bueno = marginalGain(jugador('MF', 40), corta, CTX, MLS_LEAGUE)

    expect(bueno.remaining / flojo.remaining).toBeGreaterThan(2)
  })

  it('con la plantilla completa el resultado no cambia', () => {
    // La correccion solo puede afectar a los onces con huecos. Si tocara a los
    // demas, seria otro fallo distinto.
    const llena = plantillaBase()
    expect(optimizeLineup(llena, CTX, MLS_LEAGUE).best.emptySlots).toBe(0)

    const gain = marginalGain(jugador('MF', 40), llena, CTX, MLS_LEAGUE)
    expect(gain.displaces).toBeDefined()
    // Desplaza a un mediocre, asi que aporta la diferencia, no su total.
    expect(gain.remaining).toBeLessThan(expectedRemainingPoints(jugador('MF', 40), CTX))
    expect(gain.remaining).toBeGreaterThan(0)
  })
})
