import type { Euros } from '@mls/core'
import type { MisterHttp } from './http.js'

/**
 * Endpoints de lectura de Mister.
 *
 * Dos superficies conviven en el mismo host:
 *  - /api2/*  REST moderno (BeManager). Auth y perfil.
 *  - /ajax/*  El despachador clasico de la web. Casi todos los datos.
 *
 * /ajax/sw es un despachador generico: el campo `post` del formulario decide
 * que recurso devuelve. Todas las respuestas tienen forma {status, data}.
 *
 * Los tipos son deliberadamente permisivos: la API no esta documentada ni
 * versionada, y preferimos degradar campo a campo antes que romper la ingesta
 * entera porque Mister anadio o quito una clave.
 */

export interface AjaxEnvelope<T> {
  status?: string
  data?: T
}

export interface BalanceData {
  balance?: number
  future?: number
  max_debt?: number
}

export interface BalanceInfo {
  /** Saldo disponible ahora mismo. */
  balance: Euros
  /** Saldo previsto incluyendo ventas pendientes de ejecutarse. */
  future: Euros
  /** Gasto maximo: saldo + 25% del valor de equipo en esta liga. */
  maxDebt: Euros
}

export interface RawPlayerRecord {
  id?: number | string
  name?: string
  value?: number | string
  points?: number | string
  position?: number | string
  owner?: number | string
  team?: unknown
  [k: string]: unknown
}

export interface PlayersPage {
  players?: RawPlayerRecord[]
  owners?: unknown[]
}

export interface PlayerDetail {
  player?: RawPlayerRecord & { market?: unknown }
  points_history?: unknown[]
  values_chart?: { points?: { x?: unknown; y?: number }[] }
  playerRepo?: { injuries?: unknown[] }
  [k: string]: unknown
}

export interface ManagerDetail {
  id?: number | string
  user?: { name?: string }
  season?: { points?: number; avg?: number }
  value?: number
  team_now?: RawPlayerRecord[]
  [k: string]: unknown
}

/**
 * Detalle por jugador. Es el unico sitio donde aparecen a la vez la CLAUSULA,
 * el PRECIO DE COMPRA del dueno actual y las ofertas recibidas. El precio de
 * compra es la base del calculo de clausula, asi que este endpoint es
 * imprescindible para todo el motor de riesgo.
 */
export interface CommunityPlayerInfo {
  team?: unknown
  transfer?: { price?: number } | null
  market?: { id?: string | number; price?: number } | null
  bid?: { isActive?: number; amount?: number; id?: string | number; days?: number } | null
  clause?: number | null
  clause_value?: number | null
  buyout?: number | null
  injury?: unknown
  [k: string]: unknown
}

const toInt = (v: unknown): number => {
  if (typeof v === 'number') return Math.round(v)
  if (typeof v === 'string') {
    const n = Number.parseInt(v.replace(/[^\d-]/g, ''), 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export class MisterEndpoints {
  constructor(private readonly http: MisterHttp) {}

  /** Tu saldo. Mister no expone el de los rivales: hay que reconstruirlo. */
  async getBalance(): Promise<BalanceInfo> {
    const res = await this.http.postForm<AjaxEnvelope<BalanceData>>('/ajax/balance', {})
    const d = res.data ?? {}
    return {
      balance: toInt(d.balance),
      future: toInt(d.future),
      maxDebt: toInt(d.max_debt),
    }
  }

  /**
   * Catalogo completo de jugadores de LaLiga con su valor y dueno.
   * Viene paginado de 50 en 50; iteramos hasta que una pagina vuelve vacia.
   */
  async getAllPlayers(pageSize = 50, maxPages = 40): Promise<RawPlayerRecord[]> {
    const all: RawPlayerRecord[] = []
    for (let page = 0; page < maxPages; page++) {
      const res = await this.http.postForm<AjaxEnvelope<PlayersPage>>('/ajax/sw', {
        post: 'players',
        'filters[position]': 0,
        'filters[value]': 0,
        'filters[team]': 0,
        'filters[injured]': 0,
        'filters[favs]': 0,
        'filters[owner]': 0,
        'filters[benched]': 0,
        offset: page * pageSize,
        order: 0,
        name: '',
        filtered: 0,
        parentElement: '.sw-content',
      })
      const batch = res.data?.players ?? []
      if (batch.length === 0) break
      all.push(...batch)
      if (batch.length < pageSize) break
    }
    return all
  }

  /** Historico de puntos y de valor de un jugador. */
  async getPlayerDetail(playerId: number): Promise<PlayerDetail> {
    const res = await this.http.postForm<AjaxEnvelope<PlayerDetail>>('/ajax/sw', {
      post: 'players',
      id: playerId,
    })
    return res.data ?? {}
  }

  /** Ficha de un manager rival: puntos, media, valor de equipo y plantilla. */
  async getManager(userId: number): Promise<ManagerDetail> {
    const res = await this.http.postForm<AjaxEnvelope<ManagerDetail>>('/ajax/sw', {
      post: 'users',
      id: userId,
    })
    return res.data ?? {}
  }

  /** Progresion de la clasificacion jornada a jornada. */
  async getProgression(): Promise<unknown> {
    const res = await this.http.postForm<AjaxEnvelope<unknown>>('/ajax/sw', {
      post: 'progression',
    })
    return res.data
  }

  /** Clausula, precio de compra y ofertas de un jugador concreto. */
  async getCommunityPlayerInfo(playerId: number): Promise<CommunityPlayerInfo> {
    const res = await this.http.postForm<AjaxEnvelope<CommunityPlayerInfo>>(
      '/ajax/player-community-info',
      { id_player: playerId },
    )
    return res.data ?? {}
  }

  // --- Vistas que solo existen como HTML ---

  getStandingsHtml(): Promise<string> {
    return this.http.fetchPartial('/standings')
  }

  getTeamHtml(): Promise<string> {
    return this.http.fetchPartial('/team')
  }

  getMarketHtml(): Promise<string> {
    return this.http.fetchPartial('/market')
  }

  getUserSquadHtml(userId: number): Promise<string> {
    return this.http.fetchPartial(`/users/${userId}`)
  }

  /** Feed de actividad. Con ancla #balance trae tu libro de movimientos. */
  getFeedHtml(): Promise<string> {
    return this.http.fetchPage('/feed')
  }
}

/**
 * Extrae la clausula del detalle de un jugador. Mister no es consistente con
 * el nombre de esta clave segun la vista, asi que probamos las variantes
 * conocidas antes de rendirnos.
 */
export function readClause(info: CommunityPlayerInfo): number | undefined {
  for (const key of ['clause', 'clause_value', 'buyout'] as const) {
    const v = info[key]
    if (typeof v === 'number' && v > 0) return Math.round(v)
  }
  return undefined
}

export function readPurchasePrice(info: CommunityPlayerInfo): number | undefined {
  const p = info.transfer?.price
  return typeof p === 'number' && p > 0 ? Math.round(p) : undefined
}
