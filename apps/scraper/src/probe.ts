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
      const claves = res && typeof res === 'object' ? Object.keys(res).join(', ') : '-'
      console.log(`  OK   /ajax/sw/${recurso}  claves=[${claves}]`)
      console.log(`       ${sanea(json)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.log(`  FALLA /ajax/sw/${recurso}  ${sanea(msg ?? '')}`)
    }
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('PROGRESION: QUE JORNADAS SE HAN PUNTUADO DE VERDAD')
  console.log('(los nombres de manager se sustituyen por su posicion en la lista)')
  console.log('='.repeat(72))
  try {
    const prog = (await api.getProgression()) as {
      progression?: {
        gameweeks?: unknown[]
        users?: { user?: Record<string, unknown>; points?: unknown; positions?: unknown }[]
      }
    }
    const p = prog?.progression
    console.log(`  jornadas listadas: ${JSON.stringify(p?.gameweeks ?? null)}`)
    console.log(`  managers: ${p?.users?.length ?? 0}`)
    const primero = p?.users?.[0]
    if (primero) {
      console.log(`  claves de un manager: ${Object.keys(primero).join(', ')}`)
      console.log(`  claves de .user: ${Object.keys(primero.user ?? {}).join(', ')}`)
      for (const [k, v] of Object.entries(primero)) {
        if (k === 'user') continue
        console.log(`    ${k} = ${sanea(JSON.stringify(v))}`)
      }
    }
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`)
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('ESQUEMA REAL DEL CATALOGO DE JUGADORES')
  console.log('(que claves trae de verdad /ajax/sw/players, con su tipo)')
  console.log('='.repeat(72))
  try {
    const catalogo = await api.getAllPlayers(50, 1)
    console.log(`  ${catalogo.length} registros en la primera pagina`)
    const claves = new Map<string, { tipos: Set<string>; conValor: number; muestra: string }>()
    for (const rec of catalogo) {
      for (const [k, v] of Object.entries(rec)) {
        const info = claves.get(k) ?? { tipos: new Set<string>(), conValor: 0, muestra: '' }
        info.tipos.add(v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
        if (v !== null && v !== undefined && v !== '') {
          info.conValor++
          if (!info.muestra) info.muestra = sanea(JSON.stringify(v)).slice(0, 60)
        }
        claves.set(k, info)
      }
    }
    for (const [k, info] of [...claves].sort()) {
      console.log(
        `    ${k.padEnd(22)} tipos=${[...info.tipos].join('|').padEnd(16)} ` +
          `conValor=${String(info.conValor).padStart(3)}/${catalogo.length}  ej=${info.muestra}`,
      )
    }
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`)
  }

  console.log('')
  console.log('='.repeat(72))
  console.log('MARCADO DE UNA FILA DE JUGADOR EN /team')
  console.log('(el estado se decide por iconos, asi que aqui SI se imprime el')
  console.log(' valor de href y data-position: son estructura, no contenido)')
  console.log('='.repeat(72))
  try {
    const teamHtml = await api.getTeamHtml()
    const filas = describeStructure(teamHtml, '.player-row', 3, 9, ['href', 'xlink:href', 'data-position', 'src'])
    if (filas.length === 0) console.log('  ninguna .player-row en /team')
    for (const f of filas) console.log(f)

    console.log('')
    console.log('  recuento por selector de estado sobre TODAS las filas:')
    for (const sel of [
      '.player-row', '.player-row .st-injury', '.player-row use[href*="#injury"]',
      '.player-row use[href*="#doubt"]', '.player-row use[href*="#sanction"]',
      '.player-row a.team-logo', '.player-row img.team-logo', '.player-row .shield',
      '.player-row .player-position', '.player-row .points', '.player-row .underName',
    ]) {
      const shape = describeHtml(teamHtml, [sel], 0)
      const n = shape.matches[0]?.count ?? 0
      console.log(`    ${String(n).padStart(4)}  ${sel}`)
    }
  } catch (err) {
    console.log(`  FALLA: ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`)
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
    for (const sel of ['.card-transfer']) {
      const skeletons = describeStructure(feedHtml, sel, 2, 9)
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
