import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * El repositorio git ES la base de datos.
 *
 * Para unos pocos MB por temporada, esto le gana a cualquier servicio
 * gestionado del plan gratuito: no se pausa por inactividad, no escala a cero,
 * no pide tarjeta y trae historial y rollback de serie. Si un dia el scraper
 * escribe basura, se revierte un commit.
 *
 * La unica regla importante es escribir en formato APPEND-ONLY por lineas. Si
 * reescribieramos un JSON completo dos veces al dia, cada commit cambiaria el
 * fichero entero y el repositorio engordaria sin control. Anadiendo lineas a
 * un CSV, el delta es proporcional a lo que cambia de verdad.
 */

function ensureDir(file: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(path)
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeText(path: string, text: string): void {
  ensureDir(path)
  writeFileSync(path, text, 'utf8')
}

const escapeCsv = (v: unknown): string => {
  // Un objeto en una celda seria "[object Object]", que es un dato corrupto
  // escrito en silencio. Mejor volcarlo como JSON y que se vea.
  const s =
    v === null || v === undefined ? ''
    : typeof v === 'string' ? v
    : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v)
    : JSON.stringify(v) ?? ''
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsvLine(values: unknown[]): string {
  return values.map(escapeCsv).join(',') + '\n'
}

/** Anade filas a un CSV, escribiendo la cabecera solo la primera vez. */
export function appendCsv(path: string, header: string[], rows: unknown[][]): void {
  if (rows.length === 0) return
  ensureDir(path)
  if (!existsSync(path)) writeFileSync(path, toCsvLine(header), 'utf8')
  appendFileSync(path, rows.map(toCsvLine).join(''), 'utf8')
}

/**
 * Anade solo las filas cuya clave no estuviera ya. Las transacciones se
 * releen enteras en cada ejecucion, asi que sin esto se duplicarian, y una
 * transaccion duplicada corrompe la reconstruccion de saldos.
 */
export function appendCsvDeduped(
  path: string,
  header: string[],
  rows: unknown[][],
  keyOf: (row: unknown[]) => string,
): { added: number; skipped: number } {
  ensureDir(path)
  const seen = new Set<string>()

  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue
      seen.add(keyOf(parseCsvLine(line)))
    }
  } else {
    writeFileSync(path, toCsvLine(header), 'utf8')
  }

  const fresh = rows.filter((r) => {
    const k = keyOf(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (fresh.length > 0) appendFileSync(path, fresh.map(toCsvLine).join(''), 'utf8')
  return { added: fresh.length, skipped: rows.length - fresh.length }
}

/** Parser CSV minimo, suficiente para releer lo que escribimos nosotros. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur.replace(/\r$/, ''))
  return out
}

export function countCsvRows(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length - 1
}

export interface SeasonPaths {
  root: string
  players: string
  managers: string
  transactions: string
  latest: string
  diagnosis: string
  diagnosisMd: string
  meta: string
}

export function seasonPaths(dataDir: string, seasonId: string): SeasonPaths {
  const root = join(dataDir, seasonId)
  return {
    root,
    players: join(root, 'players.csv'),
    managers: join(root, 'managers.csv'),
    transactions: join(root, 'transactions.csv'),
    latest: join(root, 'latest.json'),
    diagnosis: join(root, 'diagnostico.json'),
    diagnosisMd: join(root, 'diagnostico.md'),
    meta: join(root, 'meta.json'),
  }
}

/**
 * Reescribe el libro de movimientos fusionando lo almacenado con lo nuevo.
 *
 * El libro NO es una serie temporal como los valores de los jugadores: Mister
 * devuelve el historial COMPLETO en cada ejecucion, asi que es una lista cuya
 * fuente de verdad esta siempre del lado del servidor.
 *
 * Antes se anadia en modo append-only con una clave que incluia el importe, y
 * eso tenia un defecto que se manifesto en cuanto se corrigio un fallo del
 * parser: al cambiar el signo de las compras, la clave cambio, las filas viejas
 * no se reconocieron y el fichero acabo con 76 filas para 52 movimientos, cada
 * operacion duplicada con los dos signos.
 *
 * La leccion: una clave de deduplicacion no puede depender de valores que
 * calcula uno mismo. Aqui la clave son solo campos que da Mister (fecha, saldo
 * resultante y jugador), asi que una correccion del parser ACTUALIZA la fila en
 * lugar de duplicarla.
 *
 * Se fusiona en vez de sobrescribir por si el historial que devuelve Mister
 * estuviera acotado: lo almacenado nunca se pierde.
 */
export function writeTransactionsMerged(
  path: string,
  header: string[],
  rows: unknown[][],
  keyOf: (row: unknown[]) => string,
): { total: number; added: number; updated: number; migrated: boolean } {
  ensureDir(path)

  const stored = new Map<string, unknown[]>()
  let migrated = false

  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    const cabecera = parseCsvLine(lines[0] ?? '').map(String)
    // Si las columnas han cambiado, las filas viejas no se pueden interpretar
    // con la clave nueva: se leerian desplazadas y acabarian duplicadas con los
    // campos cruzados. Como el libro entero se puede volver a derivar del feed
    // y del balance propio, se descarta y se reescribe, que es mas seguro que
    // arrastrar filas mal alineadas.
    migrated = cabecera.length > 0 && cabecera.join(',') !== header.join(',')
    if (!migrated) {
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue
        const parsed = parseCsvLine(line)
        stored.set(keyOf(parsed), parsed)
      }
    }
  }

  let added = 0
  let updated = 0
  for (const row of rows) {
    const key = keyOf(row)
    if (stored.has(key)) {
      // Misma operacion: se queda la lectura nueva, que refleja el parser actual.
      if (toCsvLine(stored.get(key)!) !== toCsvLine(row)) updated++
      stored.set(key, row)
    } else {
      stored.set(key, row)
      added++
    }
  }

  // Cronologico, que es como se lee un libro de movimientos.
  const all = [...stored.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  writeFileSync(path, toCsvLine(header) + all.map(toCsvLine).join(''), 'utf8')

  return { total: all.length, added, updated, migrated }
}
