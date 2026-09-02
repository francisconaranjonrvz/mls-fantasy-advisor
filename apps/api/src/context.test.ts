import { describe, it, expect } from 'vitest'
import { renderState, buildSystemPrompt, type DiagnosisShape } from './context.ts'
import { stripReasoning, buildProviders, NVIDIA_MODELS } from './providers.ts'

const DIAGNOSIS: DiagnosisShape = {
  generatedAt: '2026-09-02T05:20:00.000Z',
  currentJornada: 6,
  self: {
    name: 'Olivito', points: 312, teamValue: 62_400_000,
    balance: 4_200_000, maxSpend: 19_800_000, rank: 3, pointsToLeader: 28,
  },
  rivals: [
    {
      name: 'Paquito', points: 340, teamValue: 71_000_000, threatCapacity: 26_500_000,
      balance: { low: 3_000_000, high: 8_750_000, estimate: 5_875_000, exact: false },
    },
  ],
  calibration: { error: 0, errorPct: 0, withinInterval: true },
  threats: [
    {
      player: { name: 'Pedri' }, clause: 18_000_000, sportingValue: 31_000_000,
      raidProfit: 13_000_000, risk: 'alto', threats: [{ name: 'Paquito' }],
      advice: { action: 'subir', tier: 2, cost: 4_000_000, newClause: 25_000_000, rationale: 'motivo' },
    },
  ],
  raids: [
    {
      player: { name: 'Baena' }, ownerName: 'Manolo', clause: 8_400_000,
      sportingValue: 14_200_000, profit: 5_800_000, roi: 0.69,
    },
  ],
  deadweight: [{ name: 'Se Fue', value: 8_000_000, reason: 'ya no juega en LaLiga' }],
  warnings: ['aviso de prueba'],
}

describe('renderState', () => {
  const s = renderState(DIAGNOSIS)

  it('incluye tu situacion con cifras legibles', () => {
    expect(s).toContain('puesto 3')
    expect(s).toContain('4,2M')
    expect(s).toContain('19,8M')
  })

  it('publica el saldo estimado de los rivales como intervalo, no como dato exacto', () => {
    expect(s).toContain('saldo entre 3,0M y 8,8M')
  })

  it('lleva la recomendacion del motor ya resuelta', () => {
    expect(s).toContain('Pedri')
    expect(s).toContain('Recomendacion del motor: subir')
    expect(s).toContain('coste 4,0M')
  })

  it('incluye clausulazos y lastre', () => {
    expect(s).toContain('Baena')
    expect(s).toContain('Se Fue')
  })

  it('traslada las limitaciones de los datos en vez de ocultarlas', () => {
    expect(s).toContain('LIMITACIONES')
    expect(s).toContain('aviso de prueba')
  })
})

describe('buildSystemPrompt', () => {
  const p = buildSystemPrompt({ diagnosis: DIAGNOSIS, rules: '# Reglas\nGana quien mas puntos acumule.' })

  it('prohibe explicitamente que el modelo calcule', () => {
    expect(p).toMatch(/no calcules/i)
  })

  it('incluye reglas y estado', () => {
    expect(p).toContain('Gana quien mas puntos acumule')
    expect(p).toContain('JORNADA 6')
  })
})

describe('stripReasoning', () => {
  it('elimina la cadena de pensamiento de los modelos de razonamiento', () => {
    expect(stripReasoning('<think>divago</think>La respuesta.')).toBe('La respuesta.')
    expect(stripReasoning('<reasoning>x</reasoning>  Hola  ')).toBe('Hola')
  })

  it('no toca una respuesta normal', () => {
    expect(stripReasoning('Sube la clausula de Pedri.')).toBe('Sube la clausula de Pedri.')
  })
})

describe('buildProviders', () => {
  it('usa NVIDIA por defecto cuando hay clave', () => {
    const chain = buildProviders({ NVIDIA_API_KEY: 'nvapi-x' })
    expect(chain).toHaveLength(1)
    expect(chain[0]!.name).toBe('nvidia')
    expect(chain[0]!.model).toBe(NVIDIA_MODELS.primary)
  })

  it('encadena Workers AI como respaldo si NVIDIA se queda sin creditos', () => {
    const chain = buildProviders({ NVIDIA_API_KEY: 'nvapi-x', AI: { run: async () => ({}) } })
    expect(chain.map((p) => p.name)).toEqual(['nvidia', 'workers-ai'])
  })

  it('respeta AI_PROVIDER para invertir la preferencia sin tocar codigo', () => {
    const chain = buildProviders({
      AI_PROVIDER: 'workers-ai', NVIDIA_API_KEY: 'nvapi-x', AI: { run: async () => ({}) },
    })
    expect(chain[0]!.name).toBe('workers-ai')
  })

  it('devuelve cadena vacia si no hay nada configurado', () => {
    expect(buildProviders({})).toHaveLength(0)
  })
})
