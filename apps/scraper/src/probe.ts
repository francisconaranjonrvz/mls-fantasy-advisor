import {
  MisterHttp, MisterEndpoints, authenticate, describeHtml, describeStructure,
} from '@mls/mister-client'
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
  console.log('CAMPO sign DEL LIBRO DE MOVIMIENTOS')
  console.log('='.repeat(72))
  try {
    const balance = await api.getBalance()
    const combos = new Map<string, number>()
    for (const m of balance.history) {
      // Se codifica el signo para ver el caracter exacto: un guion ASCII y un
      // menos tipografico son indistinguibles a simple vista y se comportan
      // distinto en una comparacion.
      const raw = String(m.sign ?? '(ausente)')
      const codes = [...raw].map((c) => c.charCodeAt(0)).join(',')
      const key = `tipo="${m.type ?? '?'}"  sign="${raw}" [U+${codes}]`
      combos.set(key, (combos.get(key) ?? 0) + 1)
    }
    for (const [k, n] of [...combos].sort()) console.log(`  ${String(n).padStart(3)}x  ${k}`)
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`)
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
  console.log('ESQUELETO DEL FEED DE ACTIVIDAD')
  console.log('(etiquetas y clases; el texto se sustituye por su longitud para')
  console.log(' no publicar nombres de rivales ni importes en un log publico)')
  console.log('='.repeat(72))
  try {
    const feedHtml = await api.getFeedHtml()
    for (const sel of ['.title', '.user', '.user-avatar--xs', '.news', '.activity', '.feed-item']) {
      const skeletons = describeStructure(feedHtml, sel, 1)
      if (skeletons.length === 0) continue
      console.log(`
>>> selector ${sel}`)
      for (const sk of skeletons) console.log(sk)
    }
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`)
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('FEED COMO PAGINA COMPLETA  (por si el historial llega en el HTML)')
  console.log('='.repeat(72))
  try {
    const shape = describeHtml(await api.getFeedHtml(), SELECTORES, 45)
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
