import { describe, it, expect } from 'vitest'
import { M, type Transaction } from '@mls/core'
import { auditHistory } from './balances.ts'

const tx = (
  date: string, type: Transaction['type'], amount: number, balanceAfter: number,
): Transaction => ({ date, type, amount, managerId: 1, balanceAfter })

describe('auditoria del libro de movimientos', () => {
  /**
   * Mister publica el saldo tras cada movimiento, asi que el historial lleva su
   * propia suma de verificacion. Si el saldo resultante no es el anterior mas el
   * importe, el fallo esta en como interpretamos el signo o el tipo.
   */
  const coherente = [
    tx('2026-08-20T05:00:00Z', 'purchase', M(-14.2), M(35.8)),
    tx('2026-08-27T05:00:00Z', 'sale', M(6.1), M(41.9)),
    tx('2026-09-03T05:00:00Z', 'buyout_sale', M(9.4), M(51.3)),
  ]

  it('no encuentra nada que objetar en un libro coherente', () => {
    const audit = auditHistory(coherente)
    expect(audit.checked).toBe(3)
    expect(audit.mismatches).toHaveLength(0)
  })

  it('deriva el saldo inicial sin necesitar el valor de la plantilla inicial', () => {
    // Antes del primer movimiento: 35,8M + 14,2M = 50M.
    expect(auditHistory(coherente).derivedInitialCash).toBe(M(50))
  })

  it('expone el saldo final que declara el propio libro', () => {
    expect(auditHistory(coherente).finalBalance).toBe(M(51.3))
  })

  it('senala el movimiento concreto cuyo signo se interpreta al reves', () => {
    const roto = [
      tx('2026-08-20T05:00:00Z', 'purchase', M(-14.2), M(35.8)),
      // Una compra guardada en positivo: el saldo no puede subir.
      tx('2026-08-27T05:00:00Z', 'purchase', M(6.1), M(29.7)),
    ]
    const audit = auditHistory(roto)
    expect(audit.mismatches).toHaveLength(1)
    expect(audit.mismatches[0]!.type).toBe('purchase')
    expect(audit.mismatches[0]!.diff).toBe(M(-12.2))
  })

  it('ordena cronologicamente aunque lleguen del mas reciente al mas antiguo', () => {
    // Mister los devuelve en orden inverso.
    expect(auditHistory([...coherente].reverse()).mismatches).toHaveLength(0)
  })

  it('ignora los movimientos sin saldo resultante en vez de inventarselo', () => {
    const parcial: Transaction[] = [
      ...coherente,
      { date: '2026-09-05T05:00:00Z', type: 'bonus', amount: M(1.2), managerId: 1 },
    ]
    expect(auditHistory(parcial).checked).toBe(3)
  })

  it('con un libro vacio no afirma nada', () => {
    const audit = auditHistory([])
    expect(audit.checked).toBe(0)
    expect(audit.derivedInitialCash).toBeNull()
    expect(audit.finalBalance).toBeNull()
  })
})

describe('movimientos simultaneos', () => {
  /**
   * Reproduce datos reales de la liga. El ciclo de mercado de Mister resuelve
   * varias compras a la vez y les pone la MISMA marca de tiempo, sin decir en
   * que orden las aplico. Encadenar saldos uno a uno dentro de ese grupo es
   * imposible por construccion: producia 17 descuadres falsos sobre un parseo
   * que era correcto.
   *
   * Lo comprobable, y lo que importa, es que la suma de los importes del
   * instante cuadre con el salto neto del saldo. Eso no depende del orden.
   */
  const instante = '2026-08-18T03:00:00Z'
  const simultaneos = [
    tx('2026-08-17T14:00:00Z', 'sale', M(1), M(12.472)),
    // Tres compras del mismo ciclo. Suman -2.975.082 y el saldo cae de
    // 12.472.000 a 9.496.918, exactamente esa cantidad.
    tx(instante, 'purchase', -166_000, 12_306_000),
    tx(instante, 'purchase', -1_219_462, 11_086_538),
    tx(instante, 'purchase', -1_589_620, 9_496_918),
  ]

  it('no denuncia descuadres cuando el grupo cuadra en conjunto', () => {
    expect(auditHistory(simultaneos).mismatches).toHaveLength(0)
  })

  it('el resultado no depende del orden en que lleguen los simultaneos', () => {
    const alReves = [simultaneos[0]!, simultaneos[3]!, simultaneos[1]!, simultaneos[2]!]
    expect(auditHistory(alReves).mismatches).toHaveLength(0)
  })

  it('sigue contando todos los movimientos, no solo los grupos', () => {
    expect(auditHistory(simultaneos).checked).toBe(4)
  })

  it('SI denuncia el grupo cuando la suma no cuadra con el salto de saldo', () => {
    const roto = [
      tx('2026-08-17T14:00:00Z', 'sale', M(1), M(12.472)),
      tx(instante, 'purchase', -166_000, 12_306_000),
      // Importe manipulado: el grupo ya no explica la caida del saldo.
      tx(instante, 'purchase', -1_000, 9_496_918),
    ]
    const audit = auditHistory(roto)
    expect(audit.mismatches).toHaveLength(1)
    expect(audit.mismatches[0]!.date).toBe(instante)
  })

  it('deriva el saldo inicial aunque el primer instante tenga varios movimientos', () => {
    const empiezaEnGrupo = [
      tx(instante, 'purchase', -166_000, 12_306_000),
      tx(instante, 'purchase', -1_219_462, 11_086_538),
    ]
    // Cierre 11.086.538 menos lo movido (-1.385.462) = 12.472.000.
    expect(auditHistory(empiezaEnGrupo).derivedInitialCash).toBe(12_472_000)
  })
})
