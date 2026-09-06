import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTransactionsMerged, parseCsvLine } from './storage.ts'

const HEADER = ['date', 'managerId', 'type', 'amount', 'counterpartyId', 'playerName', 'balanceAfter']
/** Clave con SOLO campos que da Mister: fecha, saldo resultante y jugador. */
const keyOf = (row: unknown[]) => `${row[0]}|${row[6]}|${row[5]}`

const fila = (date: string, type: string, amount: number, player: string, balance: number) =>
  [date, 1, type, amount, '', player, balance]

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mls-'))
  path = join(dir, 'transactions.csv')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const leer = () =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).slice(1).map(parseCsvLine)

describe('libro de movimientos', () => {
  it('escribe el historial la primera vez', () => {
    const r = writeTransactionsMerged(path, HEADER, [
      fila('2026-09-01T05:00:00Z', 'purchase', -100, 'A', 900),
      fila('2026-09-02T05:00:00Z', 'sale', 50, 'B', 950),
    ], keyOf)
    expect(r).toEqual({ total: 2, added: 2, updated: 0 })
    expect(leer()).toHaveLength(2)
  })

  it('no duplica al releer el mismo historial', () => {
    const historial = [fila('2026-09-01T05:00:00Z', 'purchase', -100, 'A', 900)]
    writeTransactionsMerged(path, HEADER, historial, keyOf)
    const r = writeTransactionsMerged(path, HEADER, historial, keyOf)
    expect(r).toEqual({ total: 1, added: 0, updated: 0 })
  })

  /**
   * La regresion que motivo este modulo. Antes la clave incluia el importe, asi
   * que al corregir el signo de las compras la fila vieja no se reconocia y se
   * anadia otra: 76 filas para 52 movimientos, cada uno con los dos signos.
   */
  it('CORRIGE la fila cuando el parser cambia de opinion, en vez de duplicarla', () => {
    // Lectura con el fallo: la compra guardada en positivo.
    writeTransactionsMerged(path, HEADER, [
      fila('2026-09-01T05:00:00Z', 'purchase', 100, 'A', 900),
    ], keyOf)

    // Lectura despues de arreglar el signo.
    const r = writeTransactionsMerged(path, HEADER, [
      fila('2026-09-01T05:00:00Z', 'purchase', -100, 'A', 900),
    ], keyOf)

    expect(r).toEqual({ total: 1, added: 0, updated: 1 })
    const filas = leer()
    expect(filas).toHaveLength(1)
    expect(filas[0]![3]).toBe('-100')
  })

  it('conserva lo almacenado si Mister devuelve un historial mas corto', () => {
    writeTransactionsMerged(path, HEADER, [
      fila('2026-09-01T05:00:00Z', 'purchase', -100, 'A', 900),
      fila('2026-09-02T05:00:00Z', 'sale', 50, 'B', 950),
    ], keyOf)
    const r = writeTransactionsMerged(path, HEADER, [
      fila('2026-09-02T05:00:00Z', 'sale', 50, 'B', 950),
    ], keyOf)
    expect(r.total).toBe(2)
    expect(leer()).toHaveLength(2)
  })

  it('deja el fichero en orden cronologico', () => {
    writeTransactionsMerged(path, HEADER, [
      fila('2026-09-03T05:00:00Z', 'sale', 10, 'C', 3),
      fila('2026-09-01T05:00:00Z', 'sale', 10, 'A', 1),
      fila('2026-09-02T05:00:00Z', 'sale', 10, 'B', 2),
    ], keyOf)
    expect(leer().map((f) => f[5])).toEqual(['A', 'B', 'C'])
  })

  it('distingue dos movimientos del mismo jugador en instantes distintos', () => {
    const r = writeTransactionsMerged(path, HEADER, [
      fila('2026-09-01T05:00:00Z', 'purchase', -100, 'A', 900),
      fila('2026-09-05T05:00:00Z', 'sale', 120, 'A', 1020),
    ], keyOf)
    expect(r.total).toBe(2)
  })

  it('crea el fichero si no existia', () => {
    expect(existsSync(path)).toBe(false)
    writeTransactionsMerged(path, HEADER, [fila('2026-09-01T05:00:00Z', 'sale', 1, 'A', 1)], keyOf)
    expect(existsSync(path)).toBe(true)
  })
})
