import { describe, it, expect } from 'vitest'
import { M } from '@mls/core'
import {
  clauseBase, defaultClause, clauseForTier, tierCost, upgradeCost,
  cheapestTierAbove, effectiveClause, refundOnLowering,
  maxClauseSpend, maxClauseSpendForSquad, maxAffordableTier,
  CLAUSE_EXCHANGE_RATE, CLAUSE_FLOOR, CLAUSE_TIERS,
} from './clauses.ts'

describe('ejemplo oficial de Mister', () => {
  // help.playmister.com/article/86: un jugador comprado por 10M tiene
  // cláusula por defecto de 15M; subirla a 25M cuesta 4M.
  const base = M(10)

  it('la cláusula por defecto de un jugador de 10M es 15M', () => {
    expect(defaultClause(base)).toBe(M(15))
  })

  it('el tramo +150% deja la cláusula en 25M', () => {
    expect(clauseForTier(base, 2)).toBe(M(25))
  })

  it('subir a 25M cuesta exactamente 4M', () => {
    expect(tierCost(base, 2)).toBe(M(4))
  })
})

describe('el tipo de cambio es constante en los tres tramos', () => {
  const base = M(12.5)

  it.each(CLAUSE_TIERS.filter((t) => t !== 0))(
    'el tramo %i cuesta 0,40 EUR por cada euro de proteccion extra',
    (tier) => {
      const extraProteccion = clauseForTier(base, tier) - defaultClause(base)
      const coste = tierCost(base, tier)
      expect(coste / extraProteccion).toBeCloseTo(CLAUSE_EXCHANGE_RATE, 10)
    },
  )

  it('no existe un tramo mas eficiente que otro', () => {
    const rates = CLAUSE_TIERS.filter((t) => t !== 0).map(
      (t) => tierCost(base, t) / (clauseForTier(base, t) - defaultClause(base)),
    )
    expect(new Set(rates.map((r) => r.toFixed(9))).size).toBe(1)
  })
})

describe('base de calculo', () => {
  it('usa el precio de compra cuando supera al valor de mercado', () => {
    expect(clauseBase({ value: M(8), purchasePrice: M(11) })).toBe(M(11))
  })

  it('usa el valor de mercado cuando supera al precio de compra', () => {
    expect(clauseBase({ value: M(14), purchasePrice: M(11) })).toBe(M(14))
  })

  it('cae al valor de mercado si no conocemos el precio de compra', () => {
    expect(clauseBase({ value: M(9) })).toBe(M(9))
  })
})

describe('suelo de 1M', () => {
  it('un jugador cuyo valor cae a 666.666 o menos tiene cláusula de 1M', () => {
    expect(defaultClause(666_666, 666_666)).toBe(CLAUSE_FLOOR)
    expect(defaultClause(500_000, 500_000)).toBe(CLAUSE_FLOOR)
  })

  it('justo por encima del umbral aplica la regla normal', () => {
    expect(defaultClause(666_667, 666_667)).toBe(Math.round(666_667 * 1.5))
  })
})

describe('cheapestTierAbove: el tramo minimo que te protege', () => {
  const base = M(10) // por defecto 15M, tramos 20 / 25 / 30M

  it('devuelve el tramo por defecto si ya estas a salvo', () => {
    expect(cheapestTierAbove(base, M(14))).toBe(0)
  })

  it('elige el tramo mas barato que supera la capacidad del rival', () => {
    expect(cheapestTierAbove(base, M(16))).toBe(1)
    expect(cheapestTierAbove(base, M(21))).toBe(2)
    expect(cheapestTierAbove(base, M(26))).toBe(3)
  })

  it('devuelve null si ni el tramo maximo alcanza: proteger es tirar el dinero', () => {
    expect(cheapestTierAbove(base, M(31))).toBeNull()
  })
})

describe('ratchet asimetrico', () => {
  const baseWhenPaid = M(10)

  it('la cláusula sube si el jugador se revaloriza', () => {
    expect(effectiveClause(2, baseWhenPaid, M(20))).toBe(M(50))
  })

  it('la cláusula se congela si el jugador se devalua', () => {
    expect(effectiveClause(2, baseWhenPaid, M(6))).toBe(M(25))
  })

  it('sin tramo pagado, la cláusula sigue al valor en ambas direcciones', () => {
    expect(effectiveClause(0, baseWhenPaid, M(6), M(6))).toBe(M(9))
    expect(effectiveClause(0, baseWhenPaid, M(20), M(20))).toBe(M(30))
  })
})

describe('subidas parciales y devoluciones', () => {
  it('subir del tramo 1 al 3 cuesta solo la diferencia', () => {
    expect(upgradeCost(M(10), 1, 3)).toBe(tierCost(M(10), 3) - tierCost(M(10), 1))
  })

  it('bajar de tramo no cuesta nada', () => {
    expect(upgradeCost(M(10), 3, 1)).toBe(0)
  })

  it('bajar la cláusula devuelve la mitad de lo invertido', () => {
    expect(refundOnLowering(M(4))).toBe(M(2))
  })
})

describe('cuanto pudo gastar un rival en subir clausulas', () => {
  /**
   * El feed no publica las modificaciones de clausula de los rivales, asi que
   * ese gasto es invisible. Pero se deduce de las clausulas que si se ven, y
   * la cota sale sola del tipo de cambio: subir n tramos deja la clausula en
   * (1,5+0,5n)B y cuesta 0,2Bn, que es 0,40(C - 1,5B). Como la base nunca es
   * menor que el valor de mercado, poner el valor en su lugar da una cota
   * superior.
   */
  it('el que tiene la clausula por defecto no gasto nada', () => {
    expect(maxClauseSpend({ value: M(10), clause: M(15) })).toBe(0)
  })

  it('la cota es 0,40 por cada euro de clausula por encima de la de por defecto', () => {
    // De 15M a 20M son 5M de mas, que a 0,40 son 2M. Y coincide con el coste
    // real del tramo 1 sobre una base de 10M: 0,2 x 10M x 1.
    expect(maxClauseSpend({ value: M(10), clause: M(20) })).toBe(M(2))
    expect(tierCost(M(10), 1)).toBe(M(2))
  })

  it('nunca se queda corta cuando el valor ha bajado desde que se pago', () => {
    // Compro a 10M, subio un tramo (2M) y el jugador cayo a 5M. La clausula
    // se congela en 20M. La cota mira el valor de hoy, que es menor, asi que
    // sale mas alta que el gasto real. Eso es lo que tiene que pasar: es una
    // cota, y equivocarse por arriba mantiene el intervalo honesto.
    expect(maxClauseSpend({ value: M(5), clause: M(20) })).toBeGreaterThanOrEqual(M(2))
  })

  it('ignora al que no tiene clausula conocida', () => {
    expect(maxClauseSpend({ value: M(10) })).toBe(0)
  })

  it('con el precio de compra delante, al comprado caro no se le imputa gasto', () => {
    /**
     * Un jugador comprado por 20M cuyo valor de mercado esta hoy en 10M tiene
     * clausula de 30M sin que su dueno haya pagado un euro por subirla: la
     * base es el precio de compra, no el valor. Sin ese dato hay que suponer
     * que se gasto 0,40 por cada euro de esos, seis millones que nunca
     * existieron, y eso ensancha el saldo estimado de su dueno.
     */
    const comprado = { value: M(10), clause: M(30), purchasePrice: M(20) }
    expect(maxClauseSpend(comprado)).toBe(0)

    const { purchasePrice: _omitido, ...sinPrecio } = comprado
    expect(maxClauseSpend(sinPrecio)).toBe(M(6))
  })

  it('sigue detectando la subida real aunque se sepa el precio de compra', () => {
    // Comprado por 10M y ademas subido un tramo: clausula 20M en vez de 15M.
    expect(maxClauseSpend({ value: M(8), clause: M(20), purchasePrice: M(10) })).toBe(M(2))
  })

  it('suma la plantilla entera', () => {
    expect(maxClauseSpendForSquad([
      { value: M(10), clause: M(15) },
      { value: M(10), clause: M(20) },
      { value: M(4), clause: M(12) },
    ])).toBe(M(2) + Math.round(0.4 * (M(12) - M(6))))
  })
})

describe('el tramo maximo', () => {
  it('es el tercero, que triplica la base', () => {
    expect(maxAffordableTier(M(10))).toBe(3)
    expect(clauseForTier(M(10), 3)).toBe(M(30))
  })
})
