import {
  M, type LeagueSnapshot, type Manager, type OwnedPlayer, type Player, type Position,
  type Transaction,
} from '@mls/core'
import type { IngestResult } from './ingest.ts'

/**
 * Liga sintetica para poder ejecutar el pipeline entero sin credenciales.
 *
 * Sirve para tres cosas: enseñar el proyecto sin dar acceso a la cuenta,
 * probar el analisis en local, y darle a CI un humo que recorre ingesta,
 * validacion, analisis e informe sin depender de que Mister este en pie.
 *
 * Los numeros estan elegidos para que aparezcan los casos interesantes: un
 * chollo protegible, un cebo cuya clausula supera lo que rinde, un jugador
 * imposible de proteger y un lastre que ya no juega en LaLiga.
 */

const NAMES = [
  'Olivito', 'Paquito', 'El Mister Loco', 'Quintela', 'Alvarito',
  'Manolo', 'Chispas', 'Tito', 'Kiko', 'Rulo',
]

let nextPlayerId = 1000

function player(
  name: string,
  value: number,
  points: number,
  over: Partial<OwnedPlayer> = {},
): Omit<OwnedPlayer, 'ownerId'> {
  return {
    id: nextPlayerId++,
    name,
    position: 'MF',
    hasTeam: true,
    status: 'ok',
    value,
    points,
    onMarket: false,
    purchasePrice: value,
    ...over,
  }
}

/**
 * Reparto de posiciones de una plantilla real de 18: sobra gente en todas las
 * lineas para que el optimizador tenga algo que decidir. Sin esto la demo no
 * podia ni completar un once y el optimizador parecia roto.
 */
const SQUAD_SHAPE: Position[] = [
  'GK', 'GK',
  'DF', 'DF', 'DF', 'DF', 'DF', 'DF',
  'MF', 'MF', 'MF', 'MF', 'MF', 'MF',
  'FW', 'FW', 'FW', 'FW',
]

export interface DemoData extends IngestResult {
  baseline: { initialSquadValueByManager: Record<string, number> }
}

export function buildDemoSnapshot(): DemoData {
  nextPlayerId = 1000
  const selfId = 4410

  const ownSquad: OwnedPlayer[] = [
    // Chollo protegible: rinde mucho para lo que cuesta, y su clausula queda
    // al alcance de algun rival.
    { ...player('Chollo Protegible', M(9), 48, { clause: M(13.5), position: 'GK' }), ownerId: selfId },
    // Cebo: clausula muy por encima de lo que va a rendir.
    { ...player('Cebo Caro', M(22), 12, { clause: M(40), position: 'DF' }), ownerId: selfId },
    // Imposible de proteger: ni el tramo maximo lo saca del alcance del rico.
    { ...player('Estrella Expuesta', M(11), 62, { clause: M(16.5), position: 'FW' }), ownerId: selfId },
    // Lastre: se fue de LaLiga, puntuara cero el resto de temporada.
    { ...player('Se Fue A Arabia', M(8), 20, { hasTeam: false, clause: M(12), position: 'DF' }), ownerId: selfId },
    // Relleno con posiciones realistas, empezando tras los 4 casos especiales.
    ...Array.from({ length: 14 }, (_, i) => ({
      ...player(`Titular ${i + 1}`, M(4 + (i % 5)), 18 + (i % 7), {
        clause: M(6 + (i % 5) * 1.5),
        position: SQUAD_SHAPE[i + 4] ?? 'MF',
      }),
      ownerId: selfId,
    })),
  ]

  const managers: Manager[] = [
    {
      id: selfId, name: NAMES[0]!, slug: 'olivito',
      points: 312, average: 52, teamValue: ownSquad.reduce((a, p) => a + p.value, 0),
      squad: ownSquad, balance: M(11.4), futureBalance: M(11.4), maxDebt: M(11.4) + M(30),
    },
    ...NAMES.slice(1).map((name, i) => {
      const id = 4411 + i
      const squad: OwnedPlayer[] = Array.from({ length: 18 }, (_, j) => ({
        ...player(`${name} J${j + 1}`, M(3 + ((i + j) % 8)), 12 + ((i * 3 + j * 5) % 40), {
          clause: M((3 + ((i + j) % 8)) * 1.5),
          position: SQUAD_SHAPE[j] ?? 'MF',
        }),
        ownerId: id,
      }))
      return {
        id, name, slug: name.toLowerCase().replace(/\s+/g, '-'),
        points: 340 - i * 18,
        average: 50 - i * 2,
        teamValue: squad.reduce((a, p) => a + p.value, 0),
        squad,
      }
    }),
  ]

  const players: Player[] = managers.flatMap((m) =>
    m.squad.map((p) => ({
      id: p.id, name: p.name, position: p.position, hasTeam: p.hasTeam,
      value: p.value, points: p.points, status: p.status, ownerId: m.id,
    })),
  )

  const transactions: Transaction[] = [
    { date: '2026-08-20T05:00:00', type: 'purchase', amount: M(-14.2), managerId: selfId, playerName: 'Chollo Protegible' },
    { date: '2026-08-27T05:00:00', type: 'sale', amount: M(6.1), managerId: selfId, playerName: 'Descarte' },
    { date: '2026-09-03T05:00:00', type: 'buyout_sale', amount: M(9.4), managerId: selfId, counterpartyId: 4412, playerName: 'Robado' },
    { date: '2026-09-05T09:00:00', type: 'bonus', amount: M(1.2), managerId: selfId, jornada: 5 },
    { date: '2026-09-06T11:30:00', type: 'clause_change', amount: M(-1.8), managerId: selfId, playerName: 'Estrella Expuesta' },
  ]

  const snapshot: LeagueSnapshot = {
    takenAt: new Date().toISOString(),
    seasonId: '2026-27',
    leagueId: 'demo',
    currentJornada: 11,
    selfId,
    managers,
    market: [
      { playerId: players[30]?.id ?? 1030, price: M(7.4) },
      { playerId: players[45]?.id ?? 1045, price: M(12.1), sellerId: 4413 },
    ],
    players,
  }

  // El baseline se elige para que la reconstruccion reproduzca EXACTAMENTE el
  // saldo declarado, y asi la demo demuestre que la aritmetica cuadra:
  //   saldo = (50M - plantilla inicial) + suma de movimientos
  //   11,4M = (50M - 39,3M) + 0,7M
  const movimientos = transactions.reduce((a, t) => a + t.amount, 0)
  const saldo = M(11.4)
  const plantillaInicial = M(50) - (saldo - movimientos)

  return {
    snapshot,
    transactions,
    balance: { balance: saldo, future: saldo, maxDebt: saldo + M(30) },
    warnings: ['datos sinteticos de demostracion: no reflejan la liga real'],
    enrichedCount: players.length,
    baseline: {
      initialSquadValueByManager: Object.fromEntries(
        managers.map((m) => [String(m.id), m.id === selfId ? plantillaInicial : M(38)]),
      ),
    },
  }
}
