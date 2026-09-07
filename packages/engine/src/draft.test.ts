import { describe, it, expect } from 'vitest'
import { M, MLS_LEAGUE, type OwnedPlayer, type Transaction } from '@mls/core'
import { estimateDraft, minimumInitialCash } from './draft.ts'

const jugador = (id: number, value: number): OwnedPlayer => ({
  id, name: `J${id}`, position: 'MF', hasTeam: true, status: 'ok',
  value, points: 10, ownerId: 1, onMarket: false,
})

const tx = (
  type: Transaction['type'],
  amount: number,
  playerId: number,
  date = '2026-08-20T05:00:00Z',
): Transaction => ({ date, type, amount, managerId: 1, playerId })

describe('que plantilla le repartieron', () => {
  /**
   * El calculo es de contabilidad elemental: lo que tiene hoy es lo que le
   * repartieron, menos lo que vendio de aquello, mas lo que ha comprado.
   * Despejar el reparto solo pide saber que jugadores de hoy llegaron
   * comprados, y eso lo dice el feed por id.
   */
  it('separa lo repartido de lo comprado', () => {
    const squad = [jugador(1, M(5)), jugador(2, M(3)), jugador(9, M(8))]
    const txs = [tx('purchase', -M(8), 9)]

    const d = estimateDraft(1, squad, txs, MLS_LEAGUE)

    // El 9 lo compro, asi que no cuenta como repartido.
    expect(d.retained).toBe(2)
    expect(d.fromRetainedValue).toBe(M(8))
    expect(d.squadValue).toBe(M(8))
    expect(d.initialCash).toBe(M(42))
  })

  it('cuenta lo que vendio de lo repartido, al precio al que lo vendio', () => {
    const squad = [jugador(1, M(5))]
    const txs = [tx('sale', M(4), 7), tx('purchase', -M(2), 8), tx('sale', M(3), 8)]

    const d = estimateDraft(1, squad, txs, MLS_LEAGUE)

    // El 7 lo vendio sin haberlo comprado: era del reparto, y valia 4M.
    // El 8 lo compro y lo vendio, asi que no era del reparto.
    expect(d.sold).toBe(1)
    expect(d.fromSalePrices).toBe(M(4))
    expect(d.squadValue).toBe(M(9))
  })

  it('ignora los movimientos de otros managers', () => {
    const squad = [jugador(1, M(5))]
    const ajena: Transaction = { ...tx('purchase', -M(3), 1), managerId: 2 }

    // Si se colara, el jugador 1 pasaria por comprado y el reparto saldria a 0.
    expect(estimateDraft(1, squad, [ajena], MLS_LEAGUE).squadValue).toBe(M(5))
  })
})

describe('caja de partida minima compatible con lo que hizo', () => {
  /**
   * Es el contraste independiente. Nadie puede quedarse por debajo del margen
   * de deuda en ningun momento, asi que el punto mas bajo del recorrido acota
   * la caja con la que arranco. Fue esta comprobacion la que delato que la
   * regla del 75% no valia para los rivales.
   */
  it('deduce el suelo del punto mas bajo del recorrido', () => {
    const txs = [
      tx('purchase', -M(20), 1, '2026-08-17T05:00:00Z'),
      tx('sale', M(6), 2, '2026-08-19T05:00:00Z'),
    ]
    // Bajo a -20M con 10M de margen sobre un equipo de 40M: arranco con 10M.
    expect(minimumInitialCash(1, M(40), txs, MLS_LEAGUE)).toBe(M(10))
  })

  it('respeta el orden: lo que se cobra despues no financia lo de antes', () => {
    const antes = [
      tx('sale', M(30), 2, '2026-08-16T05:00:00Z'),
      tx('purchase', -M(20), 1, '2026-08-17T05:00:00Z'),
    ]
    // Cobrando primero, nunca baja de cero: no hace falta caja de partida.
    expect(minimumInitialCash(1, M(40), antes, MLS_LEAGUE)).toBe(0)
  })

  it('nunca pide caja negativa', () => {
    expect(minimumInitialCash(1, M(40), [tx('sale', M(5), 2)], MLS_LEAGUE)).toBe(0)
  })
})
