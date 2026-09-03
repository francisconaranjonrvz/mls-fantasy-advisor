import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  MisterHttp, MisterEndpoints, restoreSession, cookiesFromStorageState,
  describeSession, type PlaywrightStorageState,
} from '@mls/mister-client'

/**
 * Captura la sesion de Mister desde un navegador real.
 *
 * Existe porque quien entra en Mister con "Continuar con Google" no tiene
 * contrasena nativa, asi que el login por API es imposible para esa cuenta.
 *
 * La alternativa evidente seria automatizar el propio OAuth de Google, y es
 * mala idea por dos motivos independientes: Google detecta y bloquea
 * navegadores automatizados, y meter las credenciales de una cuenta de Google
 * entera en un script para leer una liga de fantasy es un riesgo
 * desproporcionado. Aqui el navegador lo conduce la persona; el script solo
 * recoge las cookies al final.
 *
 * Se ejecuta UNA VEZ, en local. Playwright es dependencia de desarrollo y no
 * se instala en CI: alli solo viaja el texto de la sesion.
 */

const LOGIN_URL = 'https://mister.mundodeportivo.com/feed'

async function main(): Promise<void> {
  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.error(
      [
        'Falta Playwright, que solo hace falta para capturar la sesion.',
        '',
        '  pnpm --filter @mls/scraper exec playwright install chromium',
        '',
        'Si prefieres no instalarlo, puedes capturar la sesion a mano:',
        'ver la seccion "Captura manual" en docs/DESPLIEGUE.md.',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }

  console.log('Abriendo un navegador. Inicia sesion en Mister como haces siempre.\n')

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid' })
  const page = await context.newPage()
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

  console.log('Cuando veas tu liga (con el menu Mercado / Equipo / Tabla), vuelve aqui.')
  const rl = createInterface({ input: stdin, output: stdout })
  await rl.question('Pulsa Enter cuando hayas entrado... ')
  rl.close()

  const state = (await context.storageState()) as PlaywrightStorageState
  const cookies = cookiesFromStorageState(state)
  await browser.close()

  const summary = describeSession(cookies)
  if (!summary.hasRefreshToken) {
    console.error(
      [
        '',
        'No se encontro la cookie refresh-token, que es la unica de larga duracion.',
        'Cookies encontradas: ' + (summary.cookieNames.join(', ') || 'ninguna'),
        '',
        'Suele significar que se pulso Enter antes de terminar de entrar. Vuelve a intentarlo',
        'asegurandote de ver la pantalla de tu liga antes de pulsar Enter.',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }

  // Verificar ANTES de imprimir. No tiene sentido que alguien pegue una sesion
  // en un secret de GitHub y descubra dos dias despues, en un run fallido, que
  // no valia.
  console.log('\nComprobando la sesion contra Mister...')
  try {
    const http = new MisterHttp({ minDelayMs: 300, jitterMs: 200 })
    await restoreSession(cookies, http)
    const balance = await new MisterEndpoints(http).getBalance()
    console.log(`Sesion valida. Saldo leido: ${balance.balance.toLocaleString('es-ES')} EUR`)
    if (http.leagueId) console.log(`Liga detectada: ${http.leagueId}`)
  } catch (err) {
    console.error('\nLa sesion se capturo pero no funciona:')
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  const payload = Buffer.from(
    JSON.stringify({ cookies: [...cookies].map(([name, value]) => ({ name, value })) }),
    'utf8',
  ).toString('base64')

  console.log('\n' + '='.repeat(70))
  console.log('Copia este valor en el secret MISTER_SESSION del repositorio')
  console.log('(Settings > Secrets and variables > Actions > Repository secrets)')
  console.log('='.repeat(70) + '\n')
  console.log(payload)
  console.log('\n' + '='.repeat(70))
  if (summary.expiresAt) {
    console.log(`La credencial de larga duracion caduca en ${summary.expiresAt.getUTCFullYear()},`)
    console.log('asi que en la practica solo dejara de valer si cierras sesion en Mister.')
  }
  console.log('Trata este valor como una contrasena: da acceso a tu cuenta de Mister.')
}

main().catch((err) => {
  console.error('Fallo la captura:', err)
  process.exitCode = 1
})
