import {
  MisterHttp, MisterEndpoints, authenticate, parsePlayerRows, parseStandingsMembers,
  reconstructDraft, calibrateDraftDate, datesBetween, feedItemDate,
  movementsToTransactions, type PlayerDetail,
} from '@mls/mister-client'
import { MLS_LEAGUE } from '@mls/core'
import { observedInitialCash } from '@mls/engine'
import { loadConfig } from './config.ts'
import { normalizePlayer, redacted } from './ingest.ts'
import { seasonPaths, writeJson, readJson } from './storage.ts'

/**
 * Calcula el reparto inicial de la liga y lo deja escrito en baseline.json.
 *
 * Es un comando aparte y no parte de la ingesta diaria porque el reparto es
 * INMUTABLE: ocurrio una vez, en agosto, y no cambia. Meterlo en el cron
 * significaria pedir la ficha de doscientos y pico jugadores cada dia para
 * recalcular un numero que ya se sabe.
 *
 * Lo que resuelve: la caja de partida de cada manager es el presupuesto menos
 * lo que valia su plantilla repartida, y ese era el ultimo termino que se
 * suponia. Mientras se supuso, el saldo de un rival era un intervalo de varios
 * millones, y con un intervalo asi no se decide nada.
 *
 * El metodo esta validado contra la unica cuenta cuya caja inicial se conoce
 * -la propia, que la publica su libro de movimientos-: da 37.528.000 de
 * plantilla y por tanto 12.472.000 de caja, que es exactamente lo observado.
 *
 *   node src/baseline.ts            calcula y escribe
 *   node src/baseline.ts --dry-run  calcula y solo lo imprime
 */

const log = (msg: string): void => console.log(`[baseline] ${msg}`)

/** Fecha del reparto: el dia de la entrada mas antigua del feed. */
export function draftDateFromFeed(fechas: (string | undefined)[]): string | null {
  const validas = fechas.filter((f): f is string => typeof f === 'string' && f.length >= 10).sort()
  return validas.length > 0 ? validas[0]!.slice(0, 10) : null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const config = loadConfig()
  const http = new MisterHttp({ minDelayMs: config.throttleMs, jitterMs: config.throttleMs })

  const { method } = await authenticate(
    { session: config.session, email: config.email, password: config.password },
    http,
  )
  if (config.leagueId) http.leagueId = config.leagueId
  log(`autenticado por ${method}`)

  const api = new MisterEndpoints(http)

  // --- Quien tiene hoy a quien ---
  const catalogo = await api.getAllPlayers()
  const jugadores = catalogo.map(normalizePlayer).filter((p) => p !== null)
  const duennoHoy = new Map<number, number>()
  for (const p of jugadores) duennoHoy.set(p.id, p.ownerId ?? 0)
  log(`${jugadores.length} jugadores en el catalogo, ${
    [...duennoHoy.values()].filter((v) => v > 0).length} con duenno`)

  // --- Cuando fue el reparto ---
  const { items, complete } = await api.getAllFeed()
  if (!complete) {
    log('AVISO: el feed no llego al principio de temporada; la fecha del reparto puede estar mal')
  }
  const ahora = new Date()
  const inicioFeed = draftDateFromFeed(items.map((it) => feedItemDate(it, ahora)))
  if (!inicioFeed) {
    console.error('[baseline] el feed no trae ninguna fecha utilizable; se aborta')
    process.exitCode = 1
    return
  }
  // El feed arranca cuando se CREO la liga, no cuando se reparto. En esta
  // liga son nueve dias de diferencia, y valorar las plantillas con ese
  // desfase metia un error de ocho cifras en la caja inicial de todos. La
  // fecha buena se resuelve mas abajo contra la cuenta propia.
  log(`el feed arranca el ${inicioFeed}; la fecha del reparto se calibra, no se supone`)

  // --- Que jugadores hay que consultar ---
  //
  // Los que hoy tiene alguien, MAS los que aparecen en cualquier traspaso del
  // feed. Los segundos hacen falta porque un jugador repartido y luego vendido
  // ya no figura en ninguna plantilla, y sin el la plantilla inicial de quien
  // lo tuvo saldria corta.
  const candidatos = new Set<number>()
  for (const [id, duenno] of duennoHoy) if (duenno > 0) candidatos.add(id)
  for (const it of items) {
    if (it['category'] !== 'transfer') continue
    const data = it['data']
    if (!Array.isArray(data)) continue
    for (const d of data) {
      const id = Number((d as Record<string, unknown>)['id'])
      if (Number.isFinite(id) && id > 0) candidatos.add(id)
    }
  }
  log(`${candidatos.size} jugadores a consultar (plantillas de hoy + traspasados)`)

  // --- La ficha de cada uno ---
  const detalles = new Map<number, PlayerDetail>()
  let fallos = 0
  for (const id of candidatos) {
    try {
      detalles.set(id, await api.getPlayerDetail(id))
    } catch (err) {
      fallos++
      if (fallos > 20) {
        console.error(`[baseline] demasiados fallos (ultimo: ${String(err)}); se aborta`)
        process.exitCode = 1
        return
      }
    }
  }
  log(`${detalles.size} fichas leidas (${fallos} fallos)`)

  // --- Quien soy yo, que es contra quien se calibra ---
  const misIds = parsePlayerRows(await api.getTeamHtml()).map((p) => p.id)
  const votos = new Map<number, number>()
  for (const id of misIds) {
    const d = duennoHoy.get(id) ?? 0
    if (d > 0) votos.set(d, (votos.get(d) ?? 0) + 1)
  }
  let selfId = 0
  let mejorVoto = 0
  for (const [id, n] of votos) if (n > mejorVoto) { mejorVoto = n; selfId = id }
  if (selfId === 0) {
    console.error('[baseline] no se pudo identificar tu cuenta; sin ella no hay con que calibrar')
    process.exitCode = 1
    return
  }

  // La caja inicial se lee con el mismo camino que usa la ingesta, no con un
  // parser escrito aqui. La primera version traia uno propio, sin probar, y
  // devolvia una cifra equivocada: la reconstruccion del reparto era correcta
  // -en el navegador daba 37.528.000 clavados- pero se comparaba contra un
  // objetivo malo, asi que ningun dia cuadraba y el comando abortaba culpando
  // al metodo. Reescribir a mano algo que ya existe probado sale caro.
  const balance = await api.getBalance().catch(() => null)
  const propias = movementsToTransactions(balance?.history ?? [], selfId, () => undefined)
  const cajaObservada = observedInitialCash(propias)
  if (cajaObservada === null) {
    console.error('[baseline] tu libro no publica la caja inicial; sin ella no hay con que calibrar')
    process.exitCode = 1
    return
  }
  const plantillaPropia = MLS_LEAGUE.initialBudget - cajaObservada

  // --- Que dia valoro Mister el reparto ---
  const candidatas = datesBetween(inicioFeed, ahora.toISOString().slice(0, 10))
  const cal = calibrateDraftDate(detalles, duennoHoy, selfId, plantillaPropia, candidatas)

  if (cal.matches.length === 0) {
    log(`ningun dia entre ${inicioFeed} y hoy reproduce tu plantilla inicial`)
    log(`el mas cercano es ${cal.best?.date} y se queda en ${redacted(cal.best?.error ?? 0)}`)
    console.error('[baseline] no falla la fecha, falla el metodo. No te fies de nada. Se aborta.')
    process.exitCode = 1
    return
  }
  if (cal.matches.length > 1) {
    // Varios dias seguidos pueden dar la misma cifra si el mercado no movio
    // ningun jugador tuyo entre ellos. Da igual cual se elija: la plantilla
    // vale lo mismo en todos, que es lo unico que se usa.
    log(`${cal.matches.length} dias reproducen tu plantilla (${cal.matches.join(', ')})`)
  }
  const draftDate = cal.matches[0]!
  log(`fecha del reparto resuelta: ${draftDate}`)

  const reparto = reconstructDraft(detalles, duennoHoy, draftDate)

  // Un jugador que no se pudo valorar no se cuenta como cero: eso inflaria la
  // caja inicial de su duenno en silencio, que es el tipo de fallo que este
  // comando existe para cerrar. Se declara y se aborta.
  if (reparto.missingValue.length > 0) {
    log(`AVISO: ${reparto.missingValue.length} jugadores sin valor en ${draftDate}`)
    if (reparto.missingValue.length > 5) {
      console.error('[baseline] demasiados sin valorar; el baseline seria erroneo. Se aborta.')
      process.exitCode = 1
      return
    }
  }

  // --- Contraste contra la cuenta propia ---
  //
  // La unica verificacion que vale: la caja inicial propia se conoce por el
  // libro de movimientos, asi que si el metodo la reproduce, vale para los
  // nueve rivales, que es donde no hay con que comprobar.
  const members = parseStandingsMembers(await api.getStandingsHtml())
  const nombres = new Map(members.map((m) => [m.id, m.slug]))

  log('')
  log('reparto reconstruido:')
  const filas = Object.entries(reparto.valueByManager).sort((a, b) => b[1] - a[1])
  for (const [id, valor] of filas) {
    const caja = MLS_LEAGUE.initialBudget - valor
    const marca = Number(id) === selfId ? ' <- tu' : ''
    log(`  ${(nombres.get(Number(id)) ?? id).padEnd(24)} plantilla ${
      redacted(valor)}  caja ${redacted(caja)}${marca}`)
  }

  // La fecha se eligio para que tu cuenta cuadre, asi que verla en cero aqui
  // no prueba nada por si sola: lo que la hace valida es que UN SOLO dia entre
  // los treinta candidatos reproduzca la cifra exacta, y que ese dia sea el
  // mismo para todos los managers. Se vuelve a comprobar por si acaso.
  log('')
  const reconstruida = MLS_LEAGUE.initialBudget - (reparto.valueByManager[String(selfId)] ?? 0)
  const error = reconstruida - cajaObservada
  log(`CONTRASTE contra tu cuenta: error ${error === 0 ? 'CERO, exacto' : redacted(error)}`)
  if (error !== 0) {
    console.error('[baseline] la reconstruccion no cuadra con la fecha calibrada; se aborta')
    process.exitCode = 1
    return
  }

  if (dryRun) {
    log('--dry-run: no se escribe nada')
    return
  }

  const paths = seasonPaths(config.dataDir, config.seasonId)
  const previo = readJson<{ initialSquadValueByManager: Record<string, number> }>(
    `${paths.root}/baseline.json`,
  )
  if (previo) log('ya habia un baseline.json; se sobreescribe con el reconstruido')

  writeJson(`${paths.root}/baseline.json`, {
    draftDate,
    initialSquadValueByManager: reparto.valueByManager,
    players: reparto.players.length,
    generatedAt: new Date().toISOString(),
  })
  log(`escrito ${paths.root}/baseline.json con ${filas.length} managers`)
}

main().catch((err: unknown) => {
  console.error('[baseline]', err)
  process.exitCode = 1
})
