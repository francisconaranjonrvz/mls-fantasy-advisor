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
  const s = v === null || v === undefined ? '' : String(v)
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
