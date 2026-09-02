/**
 * Construccion del contexto que recibe el asistente.
 *
 * Principio rector del proyecto: **la IA no calcula nada**. Todos los numeros
 * los ha resuelto ya el motor determinista y aqui solo se redactan. Al modelo
 * se le pide explicitamente que no rehaga cuentas, porque un modelo de lenguaje
 * equivocandose en una resta de millones es justo el fallo que no nos podemos
 * permitir, y ademas suena igual de seguro cuando acierta que cuando falla.
 *
 * Los datos se leen del propio repositorio publico por HTTP. El repositorio ES
 * la base de datos, asi que el Worker no necesita ninguna otra: le basta con
 * pedir latest.json crudo a GitHub.
 */

export interface WorkerEnv {
  DATA_BASE_URL?: string
  SEASON_ID?: string
}

const DEFAULT_DATA_BASE =
  'https://raw.githubusercontent.com/francisconaranjonrvz/mls-fantasy-advisor/main'

export interface LeagueData {
  diagnosis: DiagnosisShape
  rules: string
}

/** Forma minima que necesitamos del diagnostico. El motor produce mas campos. */
export interface DiagnosisShape {
  generatedAt: string
  currentJornada: number
  self: {
    name: string
    points: number
    teamValue: number
    balance: number | null
    maxSpend: number | null
    rank: number
    pointsToLeader: number
  }
  rivals: {
    name: string
    points: number
    teamValue: number
    threatCapacity: number
    balance: { low: number; high: number; estimate: number; exact: boolean }
  }[]
  calibration: { error: number; errorPct: number; withinInterval: boolean } | null
  threats: {
    player: { name: string }
    clause: number
    sportingValue: number
    raidProfit: number
    risk: string
    threats: { name: string }[]
    advice: { action: string; tier?: number; cost?: number; newClause?: number; rationale: string }
  }[]
  raids: {
    player: { name: string }
    ownerName: string
    clause: number
    sportingValue: number
    profit: number
    roi: number
  }[]
  deadweight: { name: string; value: number; reason: string }[]
  warnings: string[]
}

const fmt = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace('.', ',')}M`
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`
  return `${sign}${abs}`
}

export async function loadLeagueData(env: WorkerEnv): Promise<LeagueData> {
  const base = env.DATA_BASE_URL ?? DEFAULT_DATA_BASE
  const season = env.SEASON_ID ?? '2026-27'

  const [latestRes, rulesRes] = await Promise.all([
    fetch(`${base}/data/${season}/diagnostico.json`, { cf: { cacheTtl: 300 } }),
    fetch(`${base}/docs/REGLAS.md`, { cf: { cacheTtl: 3600 } }),
  ])

  if (!latestRes.ok) {
    throw new Error(
      `No se pudo leer el diagnostico (${latestRes.status}). ` +
        'Es posible que la ingesta aun no haya corrido nunca.',
    )
  }

  return {
    diagnosis: (await latestRes.json()) as DiagnosisShape,
    rules: rulesRes.ok ? await rulesRes.text() : '',
  }
}

/** Resume el diagnostico en texto compacto. Mas barato y mas legible que volcar JSON. */
export function renderState(d: DiagnosisShape): string {
  const L: string[] = []

  L.push(`JORNADA ${d.currentJornada}. Datos del ${new Date(d.generatedAt).toLocaleString('es-ES')}.`)
  L.push('')
  L.push('== TU SITUACION ==')
  L.push(
    `${d.self.name}: puesto ${d.self.rank}, ${d.self.points} puntos` +
      (d.self.pointsToLeader > 0 ? `, a ${d.self.pointsToLeader} del lider.` : ' (lider).'),
  )
  L.push(`Valor de equipo ${fmt(d.self.teamValue)}.`)
  if (d.self.balance !== null) L.push(`Saldo ${fmt(d.self.balance)}.`)
  if (d.self.maxSpend !== null) L.push(`Puede gastar como maximo ${fmt(d.self.maxSpend)} hoy.`)
  L.push('')

  L.push('== RIVALES (saldo estimado, no publicado por Mister) ==')
  for (const r of d.rivals) {
    L.push(
      `${r.name}: ${r.points} pts, equipo ${fmt(r.teamValue)}, ` +
        `saldo entre ${fmt(r.balance.low)} y ${fmt(r.balance.high)}, ` +
        `puede gastar hasta ${fmt(r.threatCapacity)}.`,
    )
  }
  L.push('')

  if (d.calibration) {
    L.push('== FIABILIDAD ==')
    L.push(
      d.calibration.error === 0
        ? 'La reconstruccion reproduce exactamente el saldo real propio, asi que las estimaciones de rivales son fiables.'
        : `La reconstruccion se desvia ${fmt(d.calibration.error)} (${d.calibration.errorPct.toFixed(1)}%) al aplicarla a la cuenta propia; las estimaciones de rivales arrastran ese sesgo.`,
    )
    L.push('')
  }

  if (d.threats.length > 0) {
    L.push('== TUS JUGADORES Y SU RIESGO DE CLAUSULAZO ==')
    for (const t of d.threats) {
      L.push(
        `${t.player.name}: clausula ${fmt(t.clause)}, vale ${fmt(t.sportingValue)}, ` +
          `beneficio para quien lo robe ${fmt(t.raidProfit)}, riesgo ${t.risk}. ` +
          `Pueden pagarla: ${t.threats.map((x) => x.name).join(', ') || 'nadie'}. ` +
          `Recomendacion del motor: ${t.advice.action}` +
          (t.advice.cost ? ` (coste ${fmt(t.advice.cost)}, nueva clausula ${fmt(t.advice.newClause ?? 0)})` : '') +
          `. ${t.advice.rationale}`,
      )
    }
    L.push('')
  }

  if (d.raids.length > 0) {
    L.push('== CLAUSULAZOS VIABLES ==')
    for (const r of d.raids.slice(0, 10)) {
      L.push(
        `${r.player.name} (de ${r.ownerName}): clausula ${fmt(r.clause)}, ` +
          `vale ${fmt(r.sportingValue)}, beneficio ${fmt(r.profit)}, retorno ${(r.roi * 100).toFixed(0)}%.`,
      )
    }
    L.push('')
  }

  if (d.deadweight.length > 0) {
    L.push('== LASTRE A VENDER ==')
    for (const dw of d.deadweight) L.push(`${dw.name} (${fmt(dw.value)}): ${dw.reason}`)
    L.push('')
  }

  if (d.warnings.length > 0) {
    L.push('== LIMITACIONES DE ESTOS DATOS ==')
    for (const w of d.warnings) L.push(`- ${w}`)
  }

  return L.join('\n')
}

export function buildSystemPrompt(data: LeagueData): string {
  return `Eres el asesor personal de un participante en una liga fantasy privada de Mister (LaLiga).
Respondes en español de España, directo y sin rodeos. Tuteas.

REGLA MAS IMPORTANTE: no calcules. Todos los numeros que necesitas ya estan calculados
abajo por un motor determinista con tests. Citalos tal cual. Si te falta un numero, di que
falta; no lo estimes ni lo deduzcas mentalmente. Si algo que te preguntan no se puede
responder con los datos que tienes, dilo claramente.

Tu valor esta en lo que el motor no puede hacer: interpretar el contexto deportivo
(lesiones, rotaciones, calendario, forma), priorizar entre varias recomendaciones que
compiten por el mismo dinero, explicar el porque de una jugada, y avisar de riesgos que
un calculo no ve.

Ten presente lo que decide la liga: gana quien mas PUNTOS acumule en 38 jornadas. El
dinero y el valor de equipo son medios, no fines. Y hay dos asimetrias que conviene no
olvidar:
- Si la clausula de un jugador supera lo que va a rendir, que lo roben es BUENO.
- La escalera de bonificaciones esta invertida: acumular caja no compensa.

Cuando el usuario pida una recomendacion, se concreto: jugador, cifra y por que. Si el
motor y tu criterio deportivo discrepan, dilo y explica la discrepancia en lugar de
esconderla.

===== REGLAS DE LA LIGA =====
${data.rules}

===== ESTADO ACTUAL DE LA LIGA =====
${renderState(data.diagnosis)}`
}
