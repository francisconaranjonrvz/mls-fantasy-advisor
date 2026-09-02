import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type OwnedPlayer, type Player } from '@mls/core'
import { buildValuationContext, sportingValue, derivePricePerPoint } from './valuation.ts'
import { assessPlayerThreat, assessSquad, planProtection, type RivalCapacity } from './risk.ts'
import { evaluateRaid, findRaidTargets, planRaids, findDeadweight, isClauseWindowClosed } from './raids.ts'

const NOW = new Date('2026-09-20T12:00:00Z')

const owned = (over: Partial<OwnedPlayer> & { id: number; name: string; value: number; points: number }): OwnedPlayer => ({
  position: 'MF', hasTeam: true, status: 'ok', ownerId: 1, onMarket: false, ...over,
})

/** Catalogo sintetico: el precio del punto sale exactamente a 1M. */
const CATALOG: Player[] = Array.from({ length: 21 }, (_, i) => ({
  id: 1000 + i, name: `Jugador ${i}`, position: 'MF' as const, hasTeam: true,
  status: 'ok' as const, value: M(10), points: 10,
}))

// 10 jornadas jugadas de 38 => quedan 28.
const CTX = buildValuationContext(CATALOG, 10, 38)

describe('valoracion deportiva', () => {
  it('deriva el precio del punto como mediana del catalogo', () => {
    expect(derivePricePerPoint(CATALOG)).toBe(M(1))
  })

  it('ignora a los que no puntuan para no romper la mediana', () => {
    const conBanquillo = [...CATALOG, { ...CATALOG[0]!, id: 9999, points: 0 }]
    expect(derivePricePerPoint(conBanquillo)).toBe(M(1))
  })

  it('un jugador sin equipo en LaLiga no vale nada deportivamente', () => {
    const p = owned({ id: 1, name: 'Se fue', value: M(12), points: 40, hasTeam: false })
    expect(sportingValue(p, CTX)).toBe(0)
  })

  it('penaliza al lesionado sin anularlo', () => {
    const sano = owned({ id: 1, name: 'Sano', value: M(10), points: 20 })
    const tocado = owned({ id: 2, name: 'Tocado', value: M(10), points: 20, status: 'injured' })
    expect(sportingValue(tocado, CTX)).toBe(Math.round(sportingValue(sano, CTX) * 0.5))
  })
})

describe('a quien subirle la clausula', () => {
  const rivals: RivalCapacity[] = [
    { managerId: 2, name: 'Paquito', capacity: M(30) },
    { managerId: 3, name: 'Olivito', capacity: M(25) },
    { managerId: 4, name: 'Manolo', capacity: M(8) },
  ]

  it('marca como cebo al jugador cuya clausula supera lo que rinde', () => {
    // Caro y flojo: 2 puntos por jornada * 28 = 56 pts -> 56M de valor deportivo...
    // lo hacemos flojo de verdad: 5 puntos en 10 jornadas.
    const caroYFlojo = owned({ id: 1, name: 'Caro y flojo', value: M(20), points: 5, purchasePrice: M(20) })
    const a = assessPlayerThreat(caroYFlojo, rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.raidProfit).toBeLessThanOrEqual(0)
    expect(a.advice.action).toBe('cebo')
    expect(a.risk).toBe('ninguno')
  })

  it('recomienda subir cuando el chollo esta al alcance de un rival pero se puede sacar de ahi', () => {
    // Base 8M => por defecto 12M, tramos 16M / 20M / 24M.
    // Un rival que llega a 14M amenaza la clausula por defecto pero no el tramo 1.
    const alcanzables: RivalCapacity[] = [{ managerId: 2, name: 'Paquito', capacity: M(14) }]
    const chollo = owned({ id: 2, name: 'Chollo', value: M(8), points: 40, purchasePrice: M(8) })
    const a = assessPlayerThreat(chollo, alcanzables, CTX, MLS_LEAGUE, NOW)
    expect(a.raidProfit).toBeGreaterThan(0)
    expect(a.threats).toHaveLength(1)
    expect(a.advice.action).toBe('subir')
    expect(a.advice.tier).toBe(1)
    expect(a.advice.newClause).toBe(M(16))
  })

  it('dice que es imposible cuando ni el tramo maximo pone al jugador a salvo', () => {
    // Base 8M => el tramo maximo deja la clausula en 24M, y el rival mas rico
    // llega a 30M. Gastar en protegerlo seria tirar el dinero, y hay que decirlo.
    const chollo = owned({ id: 2, name: 'Chollo', value: M(8), points: 40, purchasePrice: M(8) })
    const a = assessPlayerThreat(chollo, rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.advice.action).toBe('imposible')
    expect(a.advice.rationale).toMatch(/No hay proteccion posible/)
  })

  it('no gasta si la clausula por defecto ya basta', () => {
    const pobres: RivalCapacity[] = [{ managerId: 4, name: 'Manolo', capacity: M(5) }]
    const chollo = owned({ id: 2, name: 'Chollo', value: M(8), points: 40, purchasePrice: M(8) })
    const a = assessPlayerThreat(chollo, pobres, CTX, MLS_LEAGUE, NOW)
    expect(a.threats).toHaveLength(0)
    expect(a.advice.action).toBe('nada')
  })

  it('un jugador blindado no corre peligro aunque sea un chollo', () => {
    const recien = owned({
      id: 3, name: 'Recien fichado', value: M(8), points: 40, purchasePrice: M(8),
      shieldedUntil: '2026-09-25T00:00:00Z',
    })
    const a = assessPlayerThreat(recien, rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.shielded).toBe(true)
    expect(a.risk).toBe('ninguno')
    expect(a.expectedLoss).toBe(0)
  })
})

describe('plan de proteccion con presupuesto', () => {
  it('atiende primero la mayor perdida evitada por euro y respeta el presupuesto', () => {
    const rivals: RivalCapacity[] = [{ managerId: 2, name: 'Paquito', capacity: M(14) }]
    const squad = [
      owned({ id: 1, name: 'A', value: M(8), points: 30, purchasePrice: M(8) }),
      owned({ id: 2, name: 'B', value: M(9), points: 28, purchasePrice: M(9) }),
    ]
    const assessments = assessSquad(squad, rivals, CTX, MLS_LEAGUE, NOW)
    const { plan, totalCost } = planProtection(assessments, M(2))
    expect(totalCost).toBeLessThanOrEqual(M(2))
    for (const p of plan) expect(p.advice.action).toBe('subir')
  })

  it('con presupuesto cero no planifica nada', () => {
    const rivals: RivalCapacity[] = [{ managerId: 2, name: 'Paquito', capacity: M(14) }]
    const squad = [owned({ id: 1, name: 'A', value: M(8), points: 30, purchasePrice: M(8) })]
    const { plan } = planProtection(assessSquad(squad, rivals, CTX, MLS_LEAGUE, NOW), 0)
    expect(plan).toHaveLength(0)
  })
})

describe('clausulazos', () => {
  const raidCtx = { capacity: M(30), squadSize: 20, clauseSigningsToday: 0, now: NOW }

  const rivalSquads = [
    {
      managerId: 2, name: 'Paquito',
      squad: [
        // Chollo: 40 pts en 10 jornadas, clausula baja.
        owned({ id: 10, name: 'Chollo Rival', value: M(8), points: 40, purchasePrice: M(8), ownerId: 2, clause: M(12) }),
        // Caro y flojo: no compensa.
        owned({ id: 11, name: 'Caro Rival', value: M(25), points: 5, purchasePrice: M(25), ownerId: 2, clause: M(37) }),
      ],
    },
  ]

  it('un jugador que rinde mas de lo que cuesta su clausula es objetivo viable', () => {
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, raidCtx, MLS_LEAGUE)
    expect(t.profit).toBeGreaterThan(0)
    expect(t.viable).toBe(true)
    expect(t.blockers).toHaveLength(0)
  })

  it('descarta al que cuesta mas de lo que rinde', () => {
    const t = evaluateRaid(rivalSquads[0]!.squad[1]!, 'Paquito', CTX, raidCtx, MLS_LEAGUE)
    expect(t.profit).toBeLessThan(0)
    expect(t.viable).toBe(false)
  })

  it('el robo se autoprotege: la clausula nueva sale del precio pagado', () => {
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, raidCtx, MLS_LEAGUE)
    expect(t.clauseAfterRaid).toBe(M(18)) // 12M pagados * 1,5
  })

  it('bloquea si no llega el saldo', () => {
    const pobre = { ...raidCtx, capacity: M(5) }
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, pobre, MLS_LEAGUE)
    expect(t.viable).toBe(false)
    expect(t.blockers.map((b) => b.reason)).toContain('sin_saldo')
  })

  it('bloquea con la plantilla llena', () => {
    const llena = { ...raidCtx, squadSize: MLS_LEAGUE.maxSquadSize }
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, llena, MLS_LEAGUE)
    expect(t.blockers.map((b) => b.reason)).toContain('plantilla_llena')
  })

  it('bloquea al agotar el limite de 3 clausulas por dia', () => {
    const agotado = { ...raidCtx, clauseSigningsToday: 3 }
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, agotado, MLS_LEAGUE)
    expect(t.blockers.map((b) => b.reason)).toContain('limite_diario')
  })

  it('respeta la ventana de bloqueo previa a la jornada', () => {
    const cerca = { ...raidCtx, nextJornadaStart: new Date(NOW.getTime() + 6 * 3_600_000) }
    expect(isClauseWindowClosed(cerca, MLS_LEAGUE)).toBe(true)
    const t = evaluateRaid(rivalSquads[0]!.squad[0]!, 'Paquito', CTX, cerca, MLS_LEAGUE)
    expect(t.blockers.map((b) => b.reason)).toContain('ventana_jornada')
  })

  it('la ventana esta abierta si la jornada queda lejos', () => {
    const lejos = { ...raidCtx, nextJornadaStart: new Date(NOW.getTime() + 72 * 3_600_000) }
    expect(isClauseWindowClosed(lejos, MLS_LEAGUE)).toBe(false)
  })

  it('ordena por retorno y pone delante los viables', () => {
    const targets = findRaidTargets(rivalSquads, CTX, raidCtx, MLS_LEAGUE)
    expect(targets[0]!.viable).toBe(true)
    expect(targets[0]!.player.id).toBe(10)
  })

  it('el plan respeta el limite diario de fichajes por clausula', () => {
    const muchos = [{
      managerId: 2, name: 'Paquito',
      squad: Array.from({ length: 6 }, (_, i) =>
        owned({ id: 20 + i, name: `Chollo ${i}`, value: M(2), points: 30, purchasePrice: M(2), ownerId: 2, clause: M(3) })),
    }]
    const targets = findRaidTargets(muchos, CTX, raidCtx, MLS_LEAGUE)
    const { plan } = planRaids(targets, raidCtx, MLS_LEAGUE)
    expect(plan.length).toBeLessThanOrEqual(MLS_LEAGUE.maxClauseSigningsPerDay)
  })

  it('el plan nunca gasta mas de la capacidad disponible', () => {
    const caros = [{
      managerId: 2, name: 'Paquito',
      squad: Array.from({ length: 3 }, (_, i) =>
        owned({ id: 30 + i, name: `Bueno ${i}`, value: M(12), points: 60, purchasePrice: M(12), ownerId: 2, clause: M(18) })),
    }]
    const targets = findRaidTargets(caros, CTX, raidCtx, MLS_LEAGUE)
    const { plan, totalCost, remainingCapacity } = planRaids(targets, raidCtx, MLS_LEAGUE)
    expect(totalCost).toBeLessThanOrEqual(raidCtx.capacity)
    expect(remainingCapacity).toBeGreaterThanOrEqual(0)
    expect(plan.length).toBe(1) // 18M de 30M: solo cabe uno
  })
})

describe('lastre a vender', () => {
  it('senala al que ya no juega en LaLiga', () => {
    const squad = [owned({ id: 1, name: 'Se fue', value: M(12), points: 40, hasTeam: false })]
    const dead = findDeadweight(squad, CTX)
    expect(dead).toHaveLength(1)
    expect(dead[0]!.reason).toMatch(/LaLiga/)
  })

  it('senala al que rinde muy por debajo de su precio', () => {
    const squad = [owned({ id: 2, name: 'Caro y flojo', value: M(20), points: 2 })]
    expect(findDeadweight(squad, CTX)).toHaveLength(1)
  })

  it('no senala a un rendimiento normal', () => {
    const squad = [owned({ id: 3, name: 'Normal', value: M(10), points: 10 })]
    expect(findDeadweight(squad, CTX)).toHaveLength(0)
  })
})

describe('amenaza cierta frente a falta de informacion', () => {
  // Base 8M => clausula por defecto 12M.
  const chollo = () => owned({ id: 50, name: 'Chollo', value: M(8), points: 40, purchasePrice: M(8) })

  it('si la cota INFERIOR del rival ya paga la clausula, la amenaza es real', () => {
    const rivals: RivalCapacity[] = [
      { managerId: 2, name: 'Paquito', capacity: M(20), capacityLow: M(14) },
    ]
    const a = assessPlayerThreat(chollo(), rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.threats).toHaveLength(1)
    expect(a.possibleThreats).toHaveLength(0)
    expect(a.advice.action).toBe('subir')
  })

  it('si solo llega en su escenario mas rico, es incertidumbre y no amenaza', () => {
    const rivals: RivalCapacity[] = [
      { managerId: 2, name: 'Paquito', capacity: M(20), capacityLow: M(4) },
    ]
    const a = assessPlayerThreat(chollo(), rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.threats).toHaveLength(0)
    expect(a.possibleThreats).toHaveLength(1)
    expect(a.advice.action).toBe('incierto')
    expect(a.advice.rationale).toMatch(/oculta el saldo ajeno/)
  })

  it('no gasta en proteger contra una sombra: sin amenaza cierta no hay perdida esperada', () => {
    const rivals: RivalCapacity[] = [
      { managerId: 2, name: 'Paquito', capacity: M(20), capacityLow: M(4) },
      { managerId: 3, name: 'Olivito', capacity: M(19), capacityLow: M(3) },
    ]
    const a = assessPlayerThreat(chollo(), rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.expectedLoss).toBe(0)
    const { plan } = planProtection([a], M(10))
    expect(plan).toHaveLength(0)
  })

  it('sin capacityLow se comporta como antes, tratando la cota superior como cierta', () => {
    const rivals: RivalCapacity[] = [{ managerId: 2, name: 'Paquito', capacity: M(14) }]
    const a = assessPlayerThreat(chollo(), rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.threats).toHaveLength(1)
    expect(a.advice.action).toBe('subir')
  })

  it('con un rival cierto y otro incierto, manda el cierto', () => {
    const rivals: RivalCapacity[] = [
      { managerId: 2, name: 'Cierto', capacity: M(14), capacityLow: M(13) },
      { managerId: 3, name: 'Incierto', capacity: M(30), capacityLow: M(2) },
    ]
    const a = assessPlayerThreat(chollo(), rivals, CTX, MLS_LEAGUE, NOW)
    expect(a.threats.map((t) => t.name)).toEqual(['Cierto'])
    expect(a.possibleThreats.map((t) => t.name)).toEqual(['Incierto'])
    expect(a.advice.action).toBe('subir')
  })
})

describe('proteger quitando el incentivo, no la capacidad', () => {
  /**
   * El hallazgo que motivo este criterio: con el margen de deuda del 25%, un
   * rival con equipo de 120M tiene 30M de capacidad aunque este a cero de
   * saldo. Perseguir esa cifra con la clausula es carisimo o imposible. Lo que
   * si funciona es dejar la clausula por encima de lo que el jugador rinde,
   * porque nadie roba a perdida.
   */
  const rico: RivalCapacity[] = [
    { managerId: 2, name: 'Rico', capacity: M(60), capacityLow: M(45) },
  ]

  it('sube solo lo justo para que el robo deje de compensar, sin perseguir el saldo del rival', () => {
    // Base 6M => clausula por defecto 9M, tramos 12 / 15 / 18M.
    // 6 puntos en 10 jornadas => 0,6/jornada => 16,8 pts restantes => 16,8M.
    // El tramo 3 (18M) es el primero que supera esos 16,8M de valor deportivo.
    const varios: RivalCapacity[] = [
      { managerId: 2, name: 'Rico', capacity: M(60), capacityLow: M(45) },
      { managerId: 3, name: 'Rico2', capacity: M(55), capacityLow: M(40) },
      { managerId: 4, name: 'Rico3', capacity: M(50), capacityLow: M(35) },
    ]
    const jugador = owned({ id: 60, name: 'Bueno', value: M(6), points: 6, purchasePrice: M(6) })
    const a = assessPlayerThreat(jugador, varios, CTX, MLS_LEAGUE, NOW)

    expect(a.sportingValue).toBeGreaterThan(a.clause)
    expect(a.advice.action).toBe('subir')
    // El tramo elegido deja la clausula por encima del valor deportivo...
    expect(a.advice.newClause!).toBeGreaterThan(a.sportingValue)
    // ...y muy por debajo de los 60M que el rival mas rico podria pagar.
    expect(a.advice.newClause!).toBeLessThan(M(60))
    expect(a.advice.rationale).toMatch(/deja de salirle a cuenta/)
  })

  it('no gasta cuando proteger cuesta mas que la perdida esperada', () => {
    // Mismo jugador pero con un solo rival: menos presion, menos perdida
    // esperada, y entonces los 4M del tramo no salen a cuenta.
    const uno: RivalCapacity[] = [{ managerId: 2, name: 'Rico', capacity: M(60), capacityLow: M(45) }]
    const jugador = owned({ id: 63, name: 'Bueno', value: M(10), points: 8, purchasePrice: M(10) })
    const a = assessPlayerThreat(jugador, uno, CTX, MLS_LEAGUE, NOW)
    expect(a.advice.action).toBe('nada')
    expect(a.advice.cost).toBeGreaterThan(a.expectedLoss)
    expect(a.advice.rationale).toMatch(/cuesta mas que la perdida esperada/)
  })

  it('no hace nada si la clausula por defecto ya supera lo que rinde', () => {
    const flojo = owned({ id: 61, name: 'Flojo', value: M(10), points: 2, purchasePrice: M(10) })
    const a = assessPlayerThreat(flojo, rico, CTX, MLS_LEAGUE, NOW)
    expect(a.advice.action).toBe('cebo')
  })

  it('solo declara imposible cuando ni quitando el incentivo ni el alcance hay salida', () => {
    // Rinde tantisimo que ni 3x su base cubre su valor deportivo.
    const crack = owned({ id: 62, name: 'Crack', value: M(5), points: 60, purchasePrice: M(5) })
    const a = assessPlayerThreat(crack, rico, CTX, MLS_LEAGUE, NOW)
    expect(a.advice.action).toBe('imposible')
    expect(a.advice.rationale).toMatch(/vendes tu/)
  })
})
