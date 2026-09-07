import { describe, it, expect } from 'vitest'
import type { Manager, OwnedPlayer } from '@mls/core'
import type { RawPlayerRecord } from '@mls/mister-client'
import {
  normalizePlayer, normalizeStatus, hasInjury,
  mergeCatalogIntoSquads, mergeClausesFromCatalog,
} from './ingest.ts'

/**
 * Registro copiado de la respuesta real de /ajax/sw/players.
 *
 * Es literal a proposito. Los tres campos que estuvieron rotos (dueno, club y
 * estado) no fallaban por un error de logica sino porque el codigo buscaba
 * claves que no existen, y contra un fixture inventado por mi ese fallo era
 * invisible: yo escribia el fixture con las mismas claves equivocadas.
 */
const RAPHINHA: RawPlayerRecord = {
  id: 48657,
  name: 'Raphinha',
  position: 4,
  value: 20209000,
  prev_value: 20186000,
  points: 56,
  avg: 14,
  streak: [12, 18, 18, 8],
  id_team: 3,
  id_uc: null,
  uc_name: null,
  status: null,
  clause: 20209000,
  shield: 0,
  id_market: null,
  is_mine: 0,
  match_info: { is_home: false, rival_team_id: 12 },
}

const owned = (over: Partial<RawPlayerRecord>): RawPlayerRecord => ({ ...RAPHINHA, ...over })

describe('normalizePlayer', () => {
  it('lee el dueno de id_uc, no de una clave `owner` que no existe', () => {
    expect(normalizePlayer(RAPHINHA)?.ownerId).toBeUndefined()
    expect(normalizePlayer(owned({ id: 1, id_uc: 15531722 }))?.ownerId).toBe(15531722)
  })

  it('lee el club de id_team: sin club, el jugador ya no puntua', () => {
    expect(normalizePlayer(RAPHINHA)?.hasTeam).toBe(true)
    expect(normalizePlayer(owned({ id_team: 0 }))?.hasTeam).toBe(false)
    expect(normalizePlayer(owned({ id_team: undefined }))?.hasTeam).toBe(false)
  })

  it('trata status a null como sano, porque la ausencia es informacion', () => {
    expect(normalizePlayer(RAPHINHA)?.status).toBe('ok')
    expect(normalizePlayer(owned({ status: 'injury' }))?.status).toBe('injured')
  })

  it('invierte la racha para dejar la jornada mas reciente delante', () => {
    // Mister la sirve de la mas antigua a la mas nueva.
    expect(normalizePlayer(RAPHINHA)?.streak).toEqual([8, 18, 18, 12])
  })

  it('deriva la tendencia comparando el valor con el anterior', () => {
    expect(normalizePlayer(RAPHINHA)?.trend).toBe('up')
    expect(normalizePlayer(owned({ value: 100, prev_value: 200 }))?.trend).toBe('down')
    expect(normalizePlayer(owned({ value: 100, prev_value: 100 }))?.trend).toBe('flat')
  })

  it('guarda el proximo rival, que es la senal de calendario', () => {
    expect(normalizePlayer(RAPHINHA)?.nextFixture).toEqual({ rivalTeamId: 12, isHome: false })
  })

  it('descarta registros sin id o sin nombre en vez de colarlos', () => {
    expect(normalizePlayer(owned({ id: 0 }))).toBeNull()
    expect(normalizePlayer(owned({ name: '  ' }))).toBeNull()
  })
})

describe('normalizeStatus', () => {
  it('acepta las variantes de Mister en ingles y en espanol', () => {
    expect(normalizeStatus(null)).toBe('ok')
    expect(normalizeStatus('injury')).toBe('injured')
    expect(normalizeStatus('lesion')).toBe('injured')
    expect(normalizeStatus('doubt')).toBe('doubt')
    expect(normalizeStatus('sanction')).toBe('sanctioned')
  })

  it('no inventa un estado conocido cuando no reconoce la etiqueta', () => {
    expect(normalizeStatus('vacaciones')).toBe('unknown')
  })
})

describe('hasInjury', () => {
  it('un array vacio significa sano, aunque en JavaScript sea truthy', () => {
    // Este es el bug exacto que dejaba el once a cero puntos esperados.
    expect(hasInjury([])).toBe(false)
    expect(hasInjury([{ from: '2026-09-01' }])).toBe(true)
    expect(hasInjury(null)).toBe(false)
    expect(hasInjury({})).toBe(false)
  })
})

const squadPlayer = (id: number): OwnedPlayer => ({
  id, name: `J${id}`, position: 'MF', hasTeam: false, value: 0, points: 0,
  status: 'injured', ownerId: 7, onMarket: false,
})

const manager = (squad: OwnedPlayer[]): Manager => ({
  id: 7, name: 'yo', slug: 'yo', points: 0, average: 0, teamValue: 0, squad,
})

describe('mergeCatalogIntoSquads', () => {
  it('corrige estado, club y racha de la plantilla con el catalogo', () => {
    const m = manager([squadPlayer(48657)])
    const catalogo = [normalizePlayer(RAPHINHA)!]

    expect(mergeCatalogIntoSquads([m], catalogo)).toBe(1)

    const p = m.squad[0]!
    expect(p.status).toBe('ok')
    expect(p.hasTeam).toBe(true)
    expect(p.value).toBe(20209000)
    expect(p.streak).toEqual([8, 18, 18, 12])
    expect(p.nextFixture).toEqual({ rivalTeamId: 12, isHome: false })
  })

  it('deja intacto al jugador que no aparece en el catalogo', () => {
    const m = manager([squadPlayer(999)])
    expect(mergeCatalogIntoSquads([m], [normalizePlayer(RAPHINHA)!])).toBe(0)
    expect(m.squad[0]!.status).toBe('injured')
  })
})

describe('mergeClausesFromCatalog', () => {
  it('saca clausula y blindaje del catalogo, sin una peticion por jugador', () => {
    const m = manager([squadPlayer(48657)])
    expect(mergeClausesFromCatalog([m], [owned({ clause: 30000000, shield: 5 })])).toBe(1)
    expect(m.squad[0]!.clause).toBe(30000000)
    expect(m.squad[0]!.shieldDays).toBe(5)
  })

  it('marca como listado a quien tiene anuncio abierto', () => {
    const m = manager([squadPlayer(48657)])
    mergeClausesFromCatalog([m], [owned({ id_market: 8812 })])
    expect(m.squad[0]!.onMarket).toBe(true)
  })

  it('no inventa blindaje cuando shield viene a cero', () => {
    const m = manager([squadPlayer(48657)])
    mergeClausesFromCatalog([m], [owned({ shield: 0 })])
    expect(m.squad[0]!.shieldDays).toBeUndefined()
  })
})
