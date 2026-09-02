import { formatShort, formatEuros } from '@mls/core'
import { CLAUSE_TIER_LABEL } from '@mls/engine'
import type { Diagnosis } from './analyze.ts'

/**
 * Informe legible del diagnostico.
 *
 * Se escribe en el repositorio junto a los datos para que quede historial, y
 * es tambien lo que se le da a la IA como resumen de partida. Un principio:
 * cada recomendacion va con su porque y con su numero, para que se pueda
 * discutir en vez de obedecer a ciegas.
 */

const bar = (n: number) => '='.repeat(n)

export function renderDiagnosis(d: Diagnosis): string {
  const L: string[] = []

  L.push(`# Diagnostico de la liga - Jornada ${d.currentJornada}`)
  L.push('')
  L.push(`Generado el ${new Date(d.generatedAt).toLocaleString('es-ES')}`)
  L.push('')

  // --- Tu situacion ---
  L.push('## Tu situacion')
  L.push('')
  L.push(`- Posicion: **${d.self.rank}** con ${d.self.points} puntos` +
    (d.self.pointsToLeader > 0 ? ` (a ${d.self.pointsToLeader} del lider)` : ' (lider)'))
  L.push(`- Valor de equipo: ${formatEuros(d.self.teamValue)}`)
  if (d.self.balance !== null) L.push(`- Saldo: ${formatEuros(d.self.balance)}`)
  if (d.self.maxSpend !== null) L.push(`- Gasto maximo hoy: ${formatEuros(d.self.maxSpend)}`)
  L.push('')

  // --- Calibracion ---
  if (d.calibration) {
    const c = d.calibration
    L.push('## Fiabilidad de las estimaciones')
    L.push('')
    L.push(
      c.error === 0
        ? 'La reconstruccion de saldos reproduce **exactamente** tu saldo real, ' +
          'asi que las estimaciones de los rivales son fiables.'
        : `La reconstruccion aplicada a tu cuenta da ${formatShort(c.reconstructed)} frente a ` +
          `${formatShort(c.actual)} reales: un error de ${formatShort(c.error)} ` +
          `(${c.errorPct.toFixed(1)}%). Las estimaciones de los rivales arrastran ese mismo sesgo.`,
    )
    L.push('')
  }

  // --- Rivales ---
  L.push('## Rivales: saldo estimado y capacidad de robo')
  L.push('')
  L.push('| Manager | Puntos | Valor equipo | Saldo estimado | Puede gastar hasta |')
  L.push('|---|---:|---:|---:|---:|')
  for (const r of d.rivals) {
    const rango = r.balance.exact
      ? formatShort(r.balance.estimate)
      : `${formatShort(r.balance.low)} a ${formatShort(r.balance.high)}`
    L.push(
      `| ${r.name} | ${r.points} | ${formatShort(r.teamValue)} | ${rango} | ` +
      `**${formatShort(r.threatCapacity)}** |`,
    )
  }
  L.push('')
  L.push(
    '> "Puede gastar hasta" usa el escenario mas rico de cada rival, sumandole el margen de ' +
    'deuda del 25% del valor de su equipo. Al protegerte conviene equivocarse por prudencia.',
  )
  L.push('')

  // --- Amenazas ---
  const enPeligro = d.threats.filter((t) => t.advice.action === 'subir' || t.advice.action === 'imposible')
  const cebos = d.threats.filter((t) => t.advice.action === 'cebo')

  L.push('## Tus jugadores en peligro')
  L.push('')
  if (enPeligro.length === 0) {
    L.push('Ningun jugador tuyo esta hoy en riesgo real de clausulazo.')
  } else {
    for (const t of enPeligro) {
      L.push(`### ${t.player.name} - riesgo ${t.risk}`)
      L.push('')
      L.push(`- Clausula actual: ${formatShort(t.clause)}`)
      L.push(`- Vale deportivamente: ${formatShort(t.sportingValue)}`)
      L.push(`- Beneficio para quien lo robe: **${formatShort(t.raidProfit)}**`)
      L.push(`- Pueden pagarla: ${t.threats.map((x) => x.name).join(', ') || 'nadie'}`)
      if (t.advice.action === 'subir' && t.advice.tier) {
        L.push(
          `- **Accion: subir al tramo ${CLAUSE_TIER_LABEL[t.advice.tier]}** ` +
          `(${formatShort(t.clause)} -> ${formatShort(t.advice.newClause ?? 0)}), ` +
          `coste ${formatShort(t.advice.cost ?? 0)}`,
        )
      }
      L.push(`- ${t.advice.rationale}`)
      L.push('')
    }
  }

  if (d.uncertainCount > 0) {
    L.push(
      `> Otros ${d.uncertainCount} jugadores tuyos no estan confirmados como seguros, pero ` +
      'tampoco hay constancia de que nadie pueda pagarles la clausula. Esa duda viene de que ' +
      'Mister oculta el saldo ajeno, no de una amenaza real, y se estrecha en cuanto la ' +
      'ingesta capture el feed de movimientos de los rivales.',
    )
    L.push('')
  }

  if (cebos.length > 0) {
    L.push('### Cebos: dejalos sin proteger a proposito')
    L.push('')
    for (const t of cebos) {
      L.push(
        `- **${t.player.name}**: clausula ${formatShort(t.clause)} frente a ` +
        `${formatShort(t.sportingValue)} de valor deportivo. Si te lo roban, ganas.`,
      )
    }
    L.push('')
  }

  // --- Plan de proteccion ---
  if (d.protection.plan.length > 0) {
    L.push('## Plan de proteccion recomendado')
    L.push('')
    for (const p of d.protection.plan) {
      L.push(
        `1. ${p.player.name}: subir a ${formatShort(p.advice.newClause ?? 0)} ` +
        `por ${formatShort(p.advice.cost ?? 0)}`,
      )
    }
    L.push('')
    L.push(`Coste total: ${formatEuros(d.protection.totalCost)}`)
    L.push('')
  }

  // --- Clausulazos ---
  L.push('## Clausulazos recomendados')
  L.push('')
  if (d.raids.length === 0) {
    L.push('Hoy no hay ningun robo que salga a cuenta con tu capacidad actual.')
  } else {
    L.push('| Jugador | Dueno | Clausula | Vale | Beneficio | Retorno |')
    L.push('|---|---|---:|---:|---:|---:|')
    for (const r of d.raids) {
      L.push(
        `| ${r.player.name} | ${r.ownerName} | ${formatShort(r.clause)} | ` +
        `${formatShort(r.sportingValue)} | ${formatShort(r.profit)} | ${(r.roi * 100).toFixed(0)}% |`,
      )
    }
    L.push('')
    if (d.raidPlan.plan.length > 0) {
      L.push(
        `**Plan de hoy** (respeta el limite de 3 clausulas diarias y tu saldo): ` +
        d.raidPlan.plan.map((r) => `${r.player.name} (${formatShort(r.clause)})`).join(', ') +
        `. Coste total ${formatShort(d.raidPlan.totalCost)}.`,
      )
      L.push('')
    }
  }

  // --- Lastre ---
  if (d.deadweight.length > 0) {
    L.push('## Lastre a vender')
    L.push('')
    for (const dw of d.deadweight) {
      L.push(`- **${dw.name}** (${formatShort(dw.value)}): ${dw.reason}`)
    }
    L.push('')
  }

  // --- Avisos ---
  if (d.warnings.length > 0) {
    L.push('## Avisos de la ingesta')
    L.push('')
    for (const w of d.warnings) L.push(`- ${w}`)
    L.push('')
  }

  return L.join('\n')
}

/** Version compacta para consola. */
export function renderConsoleSummary(d: Diagnosis): string {
  const L: string[] = []
  L.push(bar(64))
  L.push(`  Jornada ${d.currentJornada} | ${d.self.name} | ${d.self.points} pts | puesto ${d.self.rank}`)
  L.push(bar(64))
  if (d.self.balance !== null) L.push(`  Saldo: ${formatShort(d.self.balance)}   Gasto max: ${formatShort(d.self.maxSpend ?? 0)}`)
  L.push(`  Rivales analizados: ${d.rivals.length}`)
  L.push(`  Jugadores tuyos en peligro: ${d.threats.filter((t) => t.advice.action === 'subir').length}`)
  L.push(`  Clausulazos viables: ${d.raids.length}`)
  L.push(`  Lastre a vender: ${d.deadweight.length}`)
  if (d.calibration) {
    L.push(`  Calibracion del modelo: error ${formatShort(d.calibration.error)}`)
  }
  if (d.warnings.length > 0) L.push(`  Avisos: ${d.warnings.length}`)
  L.push(bar(64))
  return L.join('\n')
}
