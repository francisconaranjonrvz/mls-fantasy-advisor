/**
 * Forma del diagnostico que sirve el Worker en /api/state.
 * Es un subconjunto de lo que produce el motor: solo lo que pinta la interfaz.
 */

export interface BalanceEstimate {
  low: number
  high: number
  estimate: number
  exact: boolean
  unknowns: string[]
  constraintsApplied: string[]
}

export interface Rival {
  managerId: number
  name: string
  points: number
  teamValue: number
  threatCapacity: number
  squadSize: number
  balance: BalanceEstimate
}

export interface Threat {
  player: { id: number; name: string; value: number }
  clause: number
  sportingValue: number
  raidProfit: number
  risk: 'ninguno' | 'bajo' | 'medio' | 'alto'
  shielded: boolean
  expectedLoss: number
  threats: { managerId: number; name: string; capacity: number }[]
  possibleThreats: { managerId: number; name: string; capacity: number }[]
  advice: {
    action: 'nada' | 'subir' | 'cobrar_mas' | 'imposible' | 'cebo' | 'incierto'
    tier?: number
    cost?: number
    newClause?: number
    rationale: string
  }
}

export interface Raid {
  player: { id: number; name: string; value: number }
  ownerName: string
  clause: number
  sportingValue: number
  profit: number
  roi: number
  /** Euros por cada punto que el fichaje suma a tu once. */
  costPerPoint: number
  gain: {
    perJornada: number
    remaining: number
    displaces?: { id: number; name: string } | null
    entersLineup: boolean
  }
}

export interface MarketBuy {
  playerId: number
  name: string
  position: string
  price: number
  pointsGained: number
  costPerPoint: number
  displaces: string | null
}

export interface Market {
  bestCostPerPoint: number | null
  playerName: string | null
  price: number | null
  buys: MarketBuy[]
}

export interface Valuation {
  jornadasPlayed: number
  jornadasRemaining: number
  pricePerPoint: number
  positionMean: Record<string, number>
}

export interface Diagnosis {
  generatedAt: string
  currentJornada: number
  self: {
    managerId: number
    name: string
    points: number
    teamValue: number
    balance: number | null
    maxSpend: number | null
    rank: number
    pointsToLeader: number
  }
  rivals: Rival[]
  calibration: {
    actual: number
    reconstructed: number
    error: number
    errorPct: number
    withinInterval: boolean
  } | null
  threats: Threat[]
  uncertainCount: number
  protection: { plan: Threat[]; totalCost: number; remaining: number }
  raids: Raid[]
  raidPlan: { plan: Raid[]; totalCost: number; remainingCapacity: number }
  market: Market
  valuation: Valuation
  deadweight: { playerId: number; name: string; value: number; reason: string }[]
  lineup: {
    formation: string
    expectedPoints: number
    emptySlots: number
    penalty: number
    starters: { playerId: number; name: string; position: string; expectedPoints: number }[]
    costOfNextBest: number
    substitution: { outName: string; inName: string; gain: number; rationale: string } | null
  } | null
  warnings: string[]
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
