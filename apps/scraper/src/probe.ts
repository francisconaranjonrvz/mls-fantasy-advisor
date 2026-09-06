import { MisterHttp, MisterEndpoints, authenticate, describeHtml } from '@mls/mister-client'
import { loadConfig } from './config.ts'

/**
 * Sondeo de endpoints contra la cuenta real.
 *
 * Existe porque la API de Mister no esta documentada y ya ha cambiado bajo los
 * pies del proyecto una vez: /ajax/sw resulto no ser un despachador generico
 * sino una ruta con el recurso dentro. Adivinar el siguiente endpoint a base de
 * commits y ejecuciones de diez minutos es carisimo; preguntarle al servidor
 * cuesta una ejecucion.
 *
 * No escribe nada y no imprime cookies ni tokens: solo rutas, codigos y una
 * muestra corta y saneada de cada respuesta.
 */

const MUESTRA = 240

/** Recursos candidatos para el libro de movimientos y el feed de actividad. */
const RECURSOS_AJAX = [
  'balance', 'news', 'feed', 'movements', 'activity', 'history',
  'transfers', 'market', 'players', 'users', 'progression',
]

/** Paginas HTML de las que interesa ver la forma real del marcado. */
const PAGINAS = ['/market', '/feed', '/team', '/standings']

/** Selectores que usa el parser hoy, para ver cuales siguen existiendo. */
const SELECTORES = [
  '.player-row', '.player-avatar', '#list-on-sale', '#list-on-sale li',
  'ul.balance-history', 'ul.balance-history li', '.balance-history',
  '.type', '.reason', '.amount', '.player-pic', '.btn-bid',
]

const sanea = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, MUESTRA)

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2))
  const http = new MisterHttp({ minDelayMs: 1200, jitterMs: 600 })

  console.log('Autenticando...')
  const { method } = await authenticate(
    { session: config.session, email: config.email, password: config.password },
    http,
  )
  console.log(`Autenticado por ${method}. Liga: ${http.leagueId ?? 'sin detectar'}\n`)

  const api = new MisterEndpoints(http)

  console.log('='.repeat(72))
  console.log('RECURSOS AJAX  (POST /ajax/sw/<recurso> con post=<recurso>)')
  console.log('='.repeat(72))
  for (const recurso of RECURSOS_AJAX) {
    try {
      const res = await http.postForm<unknown>(`/ajax/sw/${recurso}`, { post: recurso })
      const json = JSON.stringify(res)
      const claves = res && typeof res === 'object' ? Object.keys(res as object).join(', ') : '-'
      console.log(`  OK   /ajax/sw/${recurso}  claves=[${claves}]`)
      console.log(`       ${sanea(json)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.log(`  FALLA /ajax/sw/${recurso}  ${sanea(msg ?? '')}`)
    }
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('PAGINAS HTML  (que selectores del parser siguen encontrando algo)')
  console.log('='.repeat(72))
  for (const pagina of PAGINAS) {
    try {
      const shape = describeHtml(await http.fetchPartial(pagina), SELECTORES)
      console.log(`
  ${pagina}  (${shape.bytes} bytes)`)
      for (const m of shape.matches) {
        console.log(`     ${String(m.count).padStart(4)}  ${m.selector}`)
      }
      if (shape.matches.length === 0) console.log('     ningun selector conocido encuentra nada')
      console.log(
        `     clases frecuentes: ${shape.topClasses.map((c) => c.name + '(' + c.count + ')').join(' ')}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.log(`\n  ${pagina}  FALLA: ${sanea(msg ?? '')}`)
    }
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('FEED COMO PAGINA COMPLETA  (por si el historial llega en el HTML)')
  console.log('='.repeat(72))
  try {
    const shape = describeHtml(await api.getFeedHtml(), SELECTORES)
    console.log(`  /feed via GET: ${shape.bytes} bytes`)
    for (const m of shape.matches) {
      console.log(`     ${String(m.count).padStart(4)}  ${m.selector}`)
    }
    if (shape.matches.length === 0) console.log('     ningun selector conocido encuentra nada')
    console.log(
      `     clases mas frecuentes: ${shape.topClasses.map((c) => `${c.name}(${c.count})`).join(' ')}`,
    )
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
}

main().catch((err) => {
  console.error('Sondeo fallido:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
