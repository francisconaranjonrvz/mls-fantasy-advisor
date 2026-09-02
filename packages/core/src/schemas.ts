import { z } from 'zod'

/**
 * Esquemas de validacion para todo lo que entra desde la API no documentada
 * de Mister. Si Mister cambia una respuesta, queremos fallar en rojo en CI
 * en lugar de commitear datos basura encima de los buenos.
 */

export const positionSchema = z.enum(['GK', 'DF', 'MF', 'FW'])
export const playerStatusSchema = z.enum(['ok', 'doubt', 'injured', 'sanctioned', 'no_team', 'unknown'])

export const playerSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  position: positionSchema,
  club: z.string().optional(),
  hasTeam: z.boolean(),
  value: z.number().int().nonnegative(),
  points: z.number().int(),
  playedMatches: z.number().int().nonnegative().optional(),
  status: playerStatusSchema,
  trend: z.enum(['up', 'down', 'flat']).optional(),
  streak: z.array(z.number().int()).optional(),
  ownerId: z.number().int().positive().optional(),
})

export const ownedPlayerSchema = playerSchema.extend({
  ownerId: z.number().int().positive(),
  purchasePrice: z.number().int().nonnegative().optional(),
  clause: z.number().int().nonnegative().optional(),
  shieldedUntil: z.string().optional(),
  onMarket: z.boolean(),
  askPrice: z.number().int().nonnegative().optional(),
})

export const managerSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string(),
  points: z.number().int(),
  average: z.number(),
  teamValue: z.number().int().nonnegative(),
  squad: z.array(ownedPlayerSchema),
  balance: z.number().int().optional(),
  futureBalance: z.number().int().optional(),
  maxDebt: z.number().int().optional(),
})

export const transactionSchema = z.object({
  date: z.string(),
  type: z.enum([
    'purchase', 'sale', 'buyout_signing', 'buyout_sale',
    'loan_purchase', 'loan_sale', 'bonus', 'clause_change',
    'salary', 'quiniela', 'unknown',
  ]),
  amount: z.number().int(),
  managerId: z.number().int().positive(),
  counterpartyId: z.number().int().positive().optional(),
  playerId: z.number().int().positive().optional(),
  playerName: z.string().optional(),
  balanceAfter: z.number().int().optional(),
  jornada: z.number().int().positive().optional(),
})

export const marketEntrySchema = z.object({
  playerId: z.number().int().positive(),
  price: z.number().int().nonnegative(),
  sellerId: z.number().int().positive().optional(),
  marketId: z.string().optional(),
  endsAt: z.string().optional(),
})

export const leagueSnapshotSchema = z.object({
  takenAt: z.string(),
  seasonId: z.string(),
  leagueId: z.string(),
  currentJornada: z.number().int().nonnegative(),
  selfId: z.number().int().positive(),
  managers: z.array(managerSchema),
  market: z.array(marketEntrySchema),
  players: z.array(playerSchema),
})

/**
 * Comprobaciones de cordura antes de escribir un snapshot al repo.
 * Evitan que un fallo de login o un cambio de HTML sobreescriba datos buenos
 * con un fichero vacio.
 */
export interface SanityOptions {
  minPlayers: number
  expectedManagers: number
  /** Fraccion minima respecto al snapshot anterior (0.8 = no aceptar caidas >20%). */
  minRatioVsPrevious: number
  previousPlayerCount?: number | undefined
}

export const DEFAULT_SANITY: Omit<SanityOptions, 'previousPlayerCount'> = {
  minPlayers: 300,
  expectedManagers: 10,
  minRatioVsPrevious: 0.8,
}

export function checkSnapshotSanity(
  snapshot: { players: unknown[]; managers: unknown[] },
  opts: SanityOptions,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = []

  if (snapshot.players.length < opts.minPlayers) {
    reasons.push(
      `solo ${snapshot.players.length} jugadores (minimo ${opts.minPlayers}) - probable fallo de login o de parseo`,
    )
  }
  if (snapshot.managers.length !== opts.expectedManagers) {
    reasons.push(
      `${snapshot.managers.length} managers, se esperaban ${opts.expectedManagers}`,
    )
  }
  if (opts.previousPlayerCount !== undefined && opts.previousPlayerCount > 0) {
    const ratio = snapshot.players.length / opts.previousPlayerCount
    if (ratio < opts.minRatioVsPrevious) {
      reasons.push(
        `el catalogo encogio a ${(ratio * 100).toFixed(0)}% del anterior ` +
        `(${snapshot.players.length} vs ${opts.previousPlayerCount})`,
      )
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
