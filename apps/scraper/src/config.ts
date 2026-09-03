import { readFileSync, existsSync } from 'node:fs'

/**
 * Configuracion por entorno.
 *
 * En local se lee .env, que esta en .gitignore. En CI llegan como secrets del
 * repositorio. Nunca, en ningun caso, van en el codigo: el repo es publico.
 */

export interface ScraperConfig {
  /**
   * Sesion capturada del navegador. Es la unica via para cuentas que entran
   * con Google, porque esas no tienen contrasena nativa de Mister.
   */
  session: string
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

  const session = process.env['MISTER_SESSION'] ?? ''
  const email = process.env['MISTER_EMAIL'] ?? ''
  const password = process.env['MISTER_PASSWORD'] ?? ''

  if (!dryRun && !demo && !session && !(email && password)) {
    throw new Error(
      [
        'No hay forma de autenticarse en Mister.',
        '',
        'Si entras en Mister con Google (lo habitual), necesitas MISTER_SESSION:',
        '  1. pnpm capture:session',
        '  2. inicia sesion en la ventana que se abre',
        '  3. pega el valor que imprime en el secret MISTER_SESSION',
        '',
        'Si tu cuenta tiene contrasena propia de Mister, valen MISTER_EMAIL y MISTER_PASSWORD.',
        '',
        'En local van en .env; en CI, como secrets del repositorio',
        '(Settings > Secrets and variables > Actions > Repository secrets).',
      ].join(String.fromCharCode(10)),
    )
  }

  return {
    session,
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
