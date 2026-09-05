import { MLS_CONTRACT, type ContractConfig } from '@mls/core'

/**
 * Contabilidad del dinero REAL de la liga, no del dinero del juego.
 *
 * Reglas del contrato firmado (docs-liga/Contrato Fantasy.pdf):
 *  - 1 EUR por participante y jornada, 38 jornadas.
 *  - El ganador de cada jornada queda EXENTO de pagar ese euro.
 *  - El bote se reparte 60/25/15 entre los tres primeros.
 *  - Se paga antes del dia 5 del mes siguiente, y una jornada cuenta en el mes
 *    en que EMPIEZA.
 *
 * Consecuencia que conviene tener presente: ganar una jornada vale 1 EUR real,
 * y con 10 participantes el bote maximo no son 380 EUR sino 342, porque 38 de
 * esos euros nunca se ingresan.
 */

export interface JornadaOutcome {
  jornada: number
  /** Manager que gano esa jornada, y por tanto no paga su euro. */
  winnerId: number
  /** ISO de la fecha en que empezo, para saber a que mes se imputa. */
  startedAt?: string | undefined
}

export interface ManagerAccount {
  managerId: number
  name: string
  jornadasWon: number
  /** Euros que le corresponde pagar por las jornadas ya disputadas. */
  owed: number
  /** Euros ahorrados por ganar jornadas. */
  saved: number
}

export interface ContractLedger {
  jornadasPlayed: number
  accounts: ManagerAccount[]
  /** Bote acumulado hasta ahora. */
  pot: number
  /** Bote si el resto de la temporada transcurre sin mas exenciones repartidas. */
  projectedPot: number
  /** Reparto del bote proyectado: primero, segundo y tercero. */
  projectedPrizes: [number, number, number]
}

/** Reparto del bote segun el contrato. Se redondea a centimos. */
export function prizeDistribution(
  pot: number,
  config: ContractConfig = MLS_CONTRACT,
): [number, number, number] {
  const round = (n: number) => Math.round(n * 100) / 100
  const [a, b, c] = config.prizeSplit
  return [round(pot * a), round(pot * b), round(pot * c)]
}

/**
 * Puntuacion efectiva: la de Mister menos las sanciones del reglamento.
 *
 * Es la que decide la liga, no la que muestra la app. El registro de sanciones
 * lo lleva la administracion de la liga, asi que entra como dato externo.
 */
export function effectivePoints(misterPoints: number, sanctions = 0): number {
  return misterPoints - sanctions
}

export function computeLedger(
  managers: { id: number; name: string }[],
  outcomes: JornadaOutcome[],
  config: ContractConfig = MLS_CONTRACT,
): ContractLedger {
  const jornadasPlayed = outcomes.length
  const winsById = new Map<number, number>()
  for (const o of outcomes) {
    winsById.set(o.winnerId, (winsById.get(o.winnerId) ?? 0) + 1)
  }

  const accounts: ManagerAccount[] = managers.map((m) => {
    const won = winsById.get(m.id) ?? 0
    return {
      managerId: m.id,
      name: m.name,
      jornadasWon: won,
      owed: (jornadasPlayed - won) * config.feePerJornada,
      saved: won * config.feePerJornada,
    }
  })

  const pot = accounts.reduce((acc, a) => acc + a.owed, 0)

  // Cada jornada que queda aporta un euro por participante menos el del
  // ganador, que siempre habra alguno.
  const remaining = Math.max(0, config.totalJornadas - jornadasPlayed)
  const projectedPot = pot + remaining * (config.participants - 1) * config.feePerJornada

  return {
    jornadasPlayed,
    accounts: accounts.sort((a, b) => b.owed - a.owed),
    pot,
    projectedPot,
    projectedPrizes: prizeDistribution(projectedPot, config),
  }
}

/**
 * Mes al que se imputa una jornada y fecha limite de pago.
 * El contrato es explicito: cuenta el mes en que la jornada EMPIEZA, y se paga
 * antes del dia 5 del mes siguiente.
 */
export function paymentDeadline(jornadaStart: Date): { month: string; deadline: Date } {
  const year = jornadaStart.getUTCFullYear()
  const month = jornadaStart.getUTCMonth()
  return {
    month: `${year}-${String(month + 1).padStart(2, '0')}`,
    deadline: new Date(Date.UTC(year, month + 1, 5)),
  }
}

/** Agrupa lo que debe cada manager por mes, que es como se paga de verdad. */
export function monthlyBreakdown(
  managers: { id: number; name: string }[],
  outcomes: JornadaOutcome[],
  config: ContractConfig = MLS_CONTRACT,
): { month: string; deadline: Date; owedByManager: Record<number, number> }[] {
  const byMonth = new Map<string, { deadline: Date; outcomes: JornadaOutcome[] }>()

  for (const o of outcomes) {
    if (!o.startedAt) continue
    const start = new Date(o.startedAt)
    if (Number.isNaN(start.getTime())) continue
    const { month, deadline } = paymentDeadline(start)
    const entry = byMonth.get(month) ?? { deadline, outcomes: [] }
    entry.outcomes.push(o)
    byMonth.set(month, entry)
  }

  return [...byMonth]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, { deadline, outcomes: os }]) => {
      const owedByManager: Record<number, number> = {}
      for (const m of managers) {
        const won = os.filter((o) => o.winnerId === m.id).length
        owedByManager[m.id] = (os.length - won) * config.feePerJornada
      }
      return { month, deadline, owedByManager }
    })
}
