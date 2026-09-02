import { readFileSync, existsSync } from 'node:fs'

/**
 * Configuracion por entorno.
 *
 * En local se lee .env, que esta en .gitignore. En CI llegan como secrets del
 * repositorio. Nunca, en ningun caso, van en el codigo: el repo es publico.
 */

export interface ScraperConfig {
  email: string
  password: string
  leagueId?: string | undefined
  seasonId: string
  dataDir: string
  dryRun: boolean
  /** Con pocos jugadores por peticion el detalle es lento; se puede limitar. */
  maxPlayerDetails: number
  /** Espera minima entre peticiones a Mister, en ms. */
  throttleMs: number
}

/** Carga .env sin dependencias externas. */
function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

export function loadConfig(argv: string[] = process.argv.slice(2)): ScraperConfig {
  loadDotEnv()
  const dryRun = argv.includes('--dry-run')
  // En modo demo no se llama a Mister, asi que no hacen falta credenciales.
  const demo = argv.includes('--demo')

  const email = process.env['MISTER_EMAIL'] ?? ''
  const password = process.env['MISTER_PASSWORD'] ?? ''

  if (!dryRun && !demo && (!email || !password)) {
    throw new Error(
      'Faltan MISTER_EMAIL y MISTER_PASSWORD.\n' +
        'En local: copia .env.example a .env y rellenalos.\n' +
        'En CI: anadelos como secrets del repositorio (Settings > Secrets and variables > Actions).',
    )
  }

  return {
    email,
    password,
    leagueId: process.env['MISTER_LEAGUE_ID'] || undefined,
    seasonId: process.env['SEASON_ID'] ?? '2026-27',
    dataDir: process.env['DATA_DIR'] ?? 'data',
    dryRun,
    maxPlayerDetails: Number.parseInt(process.env['MAX_PLAYER_DETAILS'] ?? '0', 10) || 0,
    throttleMs: Number.parseInt(process.env['THROTTLE_MS'] ?? '5000', 10),
  }
}
