import { checkSnapshotSanity, DEFAULT_SANITY, leagueSnapshotSchema } from '@mls/core'
import { loadConfig } from './config.ts'
import { ingest } from './ingest.ts'
import { analyze, type SeasonBaseline } from './analyze.ts'
import { renderDiagnosis, renderConsoleSummary } from './report.ts'
import { join } from 'node:path'
import {
  seasonPaths, writeJson, writeText, appendCsv, writeTransactionsMerged, countCsvRows, readJson,
} from './storage.ts'
import { buildDemoSnapshot } from './demo.ts'
import { MisterSessionExpiredError } from '@mls/mister-client'

/**
 * Punto de entrada de la ingesta diaria.
 *
 * Orden deliberado: se ingiere, se VALIDA, y solo entonces se escribe. El
 * fallo que mas dano haria no es que el scraper reviente (eso se ve en rojo en
 * CI), sino que "funcione" devolviendo datos vacios porque Mister cambio su
 * HTML, y sobreescriba encima del historial bueno. Por eso nada se escribe sin
 * pasar antes las comprobaciones de cordura.
 *
 *   --dry-run   ingiere y analiza, pero no escribe nada
 *   --demo      usa datos sinteticos, sin llamar a Mister
 */
/**
 * Vuelca los avisos acumulados.
 *
 * Se llama en TODAS las salidas, no solo en la de exito. Antes solo se
 * imprimian al final del camino feliz, asi que una ingesta que abortaba por
 * esquema invalido se llevaba a la tumba la explicacion de lo que habia
 * fallado.
 */
function dumpWarnings(warnings: string[]): void {
  if (warnings.length === 0) return
  console.warn('')
  console.warn(`[main] ${warnings.length} aviso(s) durante la ingesta:`)
  for (const w of warnings) console.warn(`  - ${w}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const demo = argv.includes('--demo')
  const config = loadConfig(argv)
  const paths = seasonPaths(config.dataDir, config.seasonId)

  const useDemo = demo || (config.dryRun && (!config.email || !config.password))
  if (useDemo) {
    console.log('[main] modo demo: datos sinteticos, no se llama a Mister')
  }

  const demoData = useDemo ? buildDemoSnapshot() : null
  const result = demoData ?? (await ingest(config))

  const {
    snapshot, transactions, rivalTransactions, warnings, progression, feedComplete,
    feedSelfTransactions,
  } = result

  // --- Validacion antes de tocar el disco ---
  const parsed = leagueSnapshotSchema.safeParse(snapshot)
  if (!parsed.success) {
    console.error('[main] el snapshot no cumple el esquema:')
    console.error(JSON.stringify(parsed.error.issues.slice(0, 10), null, 2))
    dumpWarnings(warnings)
    console.error('')
    console.error('Los avisos de arriba suelen explicar el fallo de esquema mejor que el')
    console.error('propio error: si no se pudo leer ningun manager, selfId se queda a 0.')
    process.exitCode = 1
    return
  }

  const previous = readJson<{ playerCount?: number }>(paths.meta)
  const sanity = checkSnapshotSanity(snapshot, {
    ...DEFAULT_SANITY,
    // En demo no exigimos el catalogo completo.
    minPlayers: useDemo ? 1 : DEFAULT_SANITY.minPlayers,
    expectedManagers: useDemo ? snapshot.managers.length : DEFAULT_SANITY.expectedManagers,
    previousPlayerCount: previous?.playerCount,
  })

  if (!sanity.ok) {
    console.error('[main] el snapshot no supera las comprobaciones de cordura:')
    for (const r of sanity.reasons) console.error(`  - ${r}`)
    dumpWarnings(warnings)
    console.error('[main] no se escribe nada para no corromper el historial')
    process.exitCode = 1
    return
  }

  const baseline =
    demoData?.baseline ?? readJson<SeasonBaseline>(join(paths.root, 'baseline.json'))
  const diagnosis = analyze(
    snapshot,
    [...transactions, ...rivalTransactions],
    warnings,
    new Date(),
    baseline,
    progression,
    feedComplete,
    feedSelfTransactions,
  )
  console.log('\n' + renderConsoleSummary(diagnosis) + '\n')

  if (config.dryRun) {
    dumpWarnings(warnings)
    console.log('[main] --dry-run: no se escribe nada')
    return
  }

  // --- Escritura append-only ---
  const at = snapshot.takenAt

  appendCsv(
    paths.players,
    ['takenAt', 'playerId', 'name', 'position', 'value', 'points', 'ownerId', 'status', 'hasTeam'],
    snapshot.players.map((p) => [
      at, p.id, p.name, p.position, p.value, p.points, p.ownerId ?? '', p.status, p.hasTeam,
    ]),
  )

  appendCsv(
    paths.managers,
    ['takenAt', 'managerId', 'name', 'points', 'teamValue', 'squadSize', 'balanceLow', 'balanceEstimate', 'balanceHigh'],
    diagnosis.rivals
      .map((r) => [
        at, r.managerId, r.name, r.points, r.teamValue, r.squadSize,
        r.balance.low, r.balance.estimate, r.balance.high,
      ])
      .concat([[
        at, diagnosis.self.managerId, diagnosis.self.name, diagnosis.self.points,
        diagnosis.self.teamValue, snapshot.managers.find((m) => m.id === snapshot.selfId)?.squad.length ?? 0,
        diagnosis.self.balance ?? '', diagnosis.self.balance ?? '', diagnosis.self.balance ?? '',
      ]]),
  )

  // Mister devuelve el historial completo en cada ejecucion, asi que el libro
  // se fusiona en lugar de anadirse. La clave usa SOLO campos que da Mister
  // (fecha, saldo resultante y jugador): si incluyera el importe, que lo
  // calcula el parser, cualquier correccion duplicaria las filas en vez de
  // corregirlas. Ya paso una vez.
  // Se guardan los apuntes de TODOS los managers, no solo los propios.
  //
  // Sin esto el libro rival se reconstruia entero en cada ejecucion y dependia
  // de que el feed siguiera alcanzando el principio de temporada para siempre.
  // Guardandolo, la carga completa se hace una vez y despues cada ejecucion
  // solo anade lo nuevo, que es como funciona la contabilidad de verdad.
  //
  // La clave de deduplicacion no puede ser la misma para las dos fuentes. El
  // libro propio trae el saldo resultante, que es un dato exacto y unico; los
  // apuntes del feed no, pero traen el id del traspaso, que tambien lo es.
  const todosLosApuntes = [...transactions, ...rivalTransactions]
  const txStats = writeTransactionsMerged(
    paths.transactions,
    [
      'date', 'managerId', 'type', 'amount', 'counterpartyId', 'playerId',
      'playerName', 'balanceAfter', 'reference',
    ],
    todosLosApuntes.map((t) => [
      t.date, t.managerId, t.type, t.amount, t.counterpartyId ?? '', t.playerId ?? '',
      t.playerName ?? '', t.balanceAfter ?? '', t.reference ?? '',
    ]),
    // El libro propio se identifica por su saldo resultante, que es exacto y
    // unico; los apuntes del feed, por el id del traspaso, que tambien lo es.
    (row) => {
      const campo = (i: number): string => {
        const v = row[i]
        return typeof v === 'string' ? v
          : typeof v === 'number' || typeof v === 'boolean' ? String(v)
          : ''
      }
      const ref = campo(8)
      return ref ? `ref:${ref}|${campo(1)}` : `own:${campo(0)}|${campo(7)}|${campo(6)}`
    },
  )
  console.log(
    `[main] libro de movimientos: ${txStats.total} en total, ` +
    `${txStats.added} nuevos, ${txStats.updated} corregidos`,
  )

  writeJson(paths.latest, { snapshot, diagnosis })
  writeJson(paths.diagnosis, diagnosis)
  writeText(paths.diagnosisMd, renderDiagnosis(diagnosis))

  // Marca de tiempo siempre presente: garantiza que cada ejecucion produce un
  // commit, lo que impide que GitHub desactive el cron por 60 dias de
  // inactividad en el repositorio.
  writeJson(paths.meta, {
    lastRunAt: at,
    playerCount: snapshot.players.length,
    managerCount: snapshot.managers.length,
    currentJornada: snapshot.currentJornada,
    transactionRows: countCsvRows(paths.transactions),
    warnings,
  })

  console.log(`[main] escrito en ${paths.root}`)
  dumpWarnings(warnings)
}

main().catch((err) => {
  // Una sesion caducada no es un fallo cualquiera: es lo unico que exige una
  // accion concreta del usuario, asi que se distingue del resto de errores en
  // lugar de esconderla dentro de un volcado de pila.
  if (err instanceof MisterSessionExpiredError) {
    console.error('')
    console.error('='.repeat(70))
    console.error('LA SESION DE MISTER HA CADUCADO')
    console.error('='.repeat(70))
    console.error(err.message)
    console.error('')
    console.error('Para arreglarlo:')
    console.error('  1. pnpm capture:session')
    console.error('  2. actualiza el secret MISTER_SESSION con el valor que imprime')
    console.error('  3. relanza el workflow "Ingesta diaria"')
    console.error('='.repeat(70))
    process.exitCode = 1
    return
  }
  console.error('[main] la ingesta fallo:', err)
  process.exitCode = 1
})
