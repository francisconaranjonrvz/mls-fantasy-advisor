import type { Euros } from '@mls/core'
import type { MisterHttp } from './http.ts'

/**
 * Endpoints de lectura de Mister.
 *
 * Dos superficies conviven en el mismo host:
 *  - /api2/*  REST moderno (BeManager). Auth y perfil.
 *  - /ajax/*  El despachador clasico de la web. Casi todos los datos.
 *
 * /ajax/sw NO es un despachador generico, aunque parte del codigo de la
 * comunidad lo usa asi. Contra produccion, POST /ajax/sw devuelve 404: el
 * recurso va en la RUTA, /ajax/sw/players, /ajax/sw/users, etc., y ademas se
 * repite en el campo `post` del formulario. Enviarlo solo en el cuerpo no
 * vale. Todas las respuestas tienen forma {status, data}.
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
  /**
   * Libro de movimientos completo.
   *
   * Es el hallazgo que hace viable la reconstruccion de saldos rivales. El
   * historial NO esta en el HTML de /feed, como sugiere la documentacion de la
   * comunidad: viene aqui, en JSON, junto al saldo. Mucho mas fiable que
   * raspar marcado.
   */
  history?: RawBalanceMovement[]
}

/** Una entrada del libro de movimientos, tal cual la devuelve Mister. */
export interface RawBalanceMovement {
  /** Marca de tiempo unix, preferible a la fecha ya formateada. */
  ts?: number
  /** Fecha formateada, "06/09/2026 - 00:11". */
  adate?: string
  /** "hace 18 horas". Solo presentacion. */
  rdate?: string
  /** Puede traer HTML: "Roberto Fernandez <span>a</span> Rxul_2504". */
  reason?: string
  /** "+" o "-". El importe viene siempre en positivo. */
  sign?: string
  amount?: number
  /** Etiqueta en el idioma de la cuenta: "Venta por clausula", "Compra"... */
  type?: string
  balance?: number
  [k: string]: unknown
}

export interface BalanceInfo {
  /** Saldo disponible ahora mismo. */
  balance: Euros
  /** Movimientos, del mas reciente al mas antiguo. */
  history: RawBalanceMovement[]
  /** Saldo previsto incluyendo ventas pendientes de ejecutarse. */
  future: Euros
  /** Gasto maximo: saldo + 25% del valor de equipo en esta liga. */
  maxDebt: Euros
}

/**
 * Un jugador tal cual lo devuelve /ajax/sw/players.
 *
 * Los nombres estan sacados del servidor, no de la documentacion de la
 * comunidad, que aqui se equivoca: no hay ninguna clave `owner` ni `team`.
 * El dueno es `id_uc` y el club es `id_team`, y leerlos mal no rompia la
 * ingesta, solo la dejaba sin senal: 523 jugadores sin dueno y sin club.
 */
export interface RawPlayerRecord {
  id?: number | string
  name?: string
  value?: number | string
  /** Valor en la actualizacion anterior. La diferencia da la tendencia. */
  prev_value?: number | string
  points?: number | string
  /** 1 GK, 2 DF, 3 MF, 4 FW. */
  position?: number | string
  /** Media por jornada. */
  avg?: number | string
  /** Puntuaciones recientes, de la mas antigua a la mas nueva. */
  streak?: unknown
  /** Id del club real. 0 o ausente = ya no esta en LaLiga. */
  id_team?: number | string
  /** Id del manager de la liga que lo posee. null = agente libre. */
  id_uc?: number | string | null
  /** Nombre del manager que lo posee. */
  uc_name?: string | null
  /** null cuando esta sano; "injury", "doubt", "sanction"... cuando no. */
  status?: string | null
  /** Clausula de rescision vigente, para CUALQUIER jugador de la liga. */
  clause?: number | string
  /** Dias de blindaje que le quedan. 0 = se le puede pagar la clausula. */
  shield?: number | string
  /** Id del anuncio si esta listado en el mercado. */
  id_market?: number | string | null
  /** 1 si es tuyo. */
  is_mine?: number | string
  /** Proximo partido. */
  match_info?: { is_home?: boolean; rival_team_id?: number } | null
  [k: string]: unknown
}

/**
 * Tamano de pagina del feed. El front usa el valor que le da el servidor en
 * `_FG_data.feed.cardsPerPage`; veinte es lo que se observa en produccion y
 * pedir mas no acelera nada porque el limite lo pone el servidor.
 */
export const FEED_PAGE_SIZE = 20

/** Una entrada del feed tal cual la sirve /ajax/feed. */
export interface RawFeedItem {
  id?: number | string
  id_community?: number | string
  id_competition?: number | string | null
  [k: string]: unknown
}

export interface FeedPage {
  items: RawFeedItem[]
  /** El servidor ya no tiene mas: se ha llegado al principio de temporada. */
  end: boolean
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
  private readonly http: MisterHttp

  constructor(http: MisterHttp) {
    this.http = http
  }

  /**
   * Tu saldo. Mister no expone el de los rivales: hay que reconstruirlo.
   *
   * Se prueban las dos rutas que circulan por los clientes de la comunidad.
   * /ajax/balance responde, pero devolvia todo a cero contra la cuenta real,
   * asi que se intenta primero la variante con recurso en la ruta, que es la
   * que usa el cliente que si funciona en produccion.
   */
  async getBalance(): Promise<BalanceInfo> {
    let res: AjaxEnvelope<BalanceData>
    try {
      res = await this.http.postForm<AjaxEnvelope<BalanceData>>('/ajax/sw/balance', {
        post: 'balance',
      })
    } catch {
      res = await this.http.postForm<AjaxEnvelope<BalanceData>>('/ajax/balance', {})
    }
    const d = res.data ?? {}
    return {
      balance: toInt(d.balance),
      future: toInt(d.future),
      maxDebt: toInt(d.max_debt),
      history: Array.isArray(d.history) ? d.history : [],
    }
  }

  /**
   * Catalogo completo de jugadores de LaLiga con su valor y dueno.
   * Viene paginado de 50 en 50; iteramos hasta que una pagina vuelve vacia.
   */
  async getAllPlayers(pageSize = 50, maxPages = 40): Promise<RawPlayerRecord[]> {
    const all: RawPlayerRecord[] = []
    for (let page = 0; page < maxPages; page++) {
      const res = await this.http.postForm<AjaxEnvelope<PlayersPage>>('/ajax/sw/players', {
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

  /**
   * El feed entero, paginando hacia atras hasta el principio de temporada.
   *
   * Contra la liga real son 22 paginas y 414 entradas, y el servidor avisa
   * cuando se acaban. El tope existe solo para que un cambio en el servidor no
   * pueda convertir esto en un bucle infinito.
   */
  async getAllFeed(maxPages = 60): Promise<{ items: RawFeedItem[]; complete: boolean }> {
    const all: RawFeedItem[] = []
    for (let page = 0; page < maxPages; page++) {
      const { items, end } = await this.getFeedPage(page * FEED_PAGE_SIZE)
      all.push(...items)
      // Solo se declara completo si fue el SERVIDOR quien dijo que no hay mas.
      // Si se acabaran las paginas permitidas, el historial estaria cortado y
      // dar por completo lo que no lo es convertiria una estimacion honesta en
      // una cifra falsamente exacta.
      if (end || items.length === 0) return { items: all, complete: true }
    }
    return { items: all, complete: false }
  }

  /** Historico de puntos y de valor de un jugador. */
  async getPlayerDetail(playerId: number): Promise<PlayerDetail> {
    const res = await this.http.postForm<AjaxEnvelope<PlayerDetail>>('/ajax/sw/players', {
      post: 'players',
      id: playerId,
    })
    return res.data ?? {}
  }

  /** Ficha de un manager rival: puntos, media, valor de equipo y plantilla. */
  async getManager(userId: number): Promise<ManagerDetail> {
    const res = await this.http.postForm<AjaxEnvelope<ManagerDetail>>('/ajax/sw/users', {
      post: 'users',
      id: userId,
    })
    return res.data ?? {}
  }

  /**
   * Puesto de cada manager en cada jornada cerrada.
   *
   * Es el dato que convierte las bonificaciones de jornada de estimacion en
   * cifra exacta, tambien para los rivales: la bonificacion depende solo del
   * puesto, y el puesto esta aqui. Sin esto, cada jornada anadia entre 1,0M y
   * 1,5M de incertidumbre al saldo estimado de los nueve rivales.
   */
  async getProgression(): Promise<LeagueProgression> {
    const res = await this.http.postForm<AjaxEnvelope<RawProgression>>('/ajax/sw/progression', {
      post: 'progression',
    })
    return normalizeProgression(res.data)
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

  /**
   * Plantilla de un rival.
   *
   * La URL lleva slug: /users/{id}/{slug}. Sin el, Mister responde 302 hacia la
   * forma canonica, asi que pedir solo /users/{id} fallaba para los diez
   * rivales a la vez. El slug sale de los enlaces de /standings.
   */
  getUserSquadHtml(userId: number, slug?: string): Promise<string> {
    const path = slug ? `/users/${userId}/${slug}` : `/users/${userId}`
    return this.http.fetchPartial(path)
  }

  /** Feed de actividad. Con ancla #balance trae tu libro de movimientos. */
  getFeedHtml(): Promise<string> {
    return this.http.fetchPage('/feed')
  }

  /**
   * Una pagina del feed de actividad, en JSON.
   *
   * Es la peticion que hace el navegador al llegar abajo del todo, y la clave
   * para reconstruir el saldo ajeno como una suma en vez de como una
   * estimacion: pidiendo paginas hacia atras se llega al principio de
   * temporada, con lo que el historial de traspasos deja de estar cortado.
   *
   * Salio de leer el propio front: `load_more()` en views/feed.functions.js
   * hace `$.ajax({url: 'ajax/feed', data: _FG_data.feed})`, y ese objeto
   * lleva `offset` y `cardsPerPage`. Cuando se acaba, el servidor responde
   * `status: 'end'` en vez de `ok`.
   *
   * Nada de esto aparece en /ajax/sw/*: probados news, feed, movements,
   * activity, history, transfers y timeline, todos 404. El recurso vive en
   * /ajax/feed a secas.
   */
  async getFeedPage(offset: number, cardsPerPage = FEED_PAGE_SIZE): Promise<FeedPage> {
    const res = await this.http.postForm<AjaxEnvelope<RawFeedItem[]>>('/ajax/feed', {
      offset,
      cardsPerPage,
      // El front manda su objeto de estado entero, con estos dos dentro.
      loading: 'false',
      end: 'false',
    })
    return {
      items: Array.isArray(res.data) ? res.data : [],
      // El front trata cualquier estado distinto de "ok" como fin del feed.
      end: res.status !== 'ok',
    }
  }
}

/**
 * Progresion tal cual la sirve Mister.
 *
 * `gameweeks` son etiquetas ("J2", "J3", "J4", "J6"), y el hueco entre ellas es
 * informacion: en esta liga la primera y la quinta no se puntuaron. Cada
 * manager trae un mapa de numero de jornada a puesto.
 */
interface RawProgression {
  progression?: {
    gameweeks?: unknown[]
    users?: {
      user?: { id_uc?: number | string; name?: string }
      progression?: Record<string, number | string>
    }[]
  }
}

export interface ManagerProgression {
  managerId: number
  name: string
  /** Puesto en cada jornada cerrada. 1 es el mejor. */
  ranks: { jornada: number; rank: number }[]
}

export interface LeagueProgression {
  /** Numeros de jornada que se han puntuado, en orden. */
  jornadas: number[]
  managers: ManagerProgression[]
}

export function normalizeProgression(raw: RawProgression | undefined): LeagueProgression {
  const p = raw?.progression
  const jornadas = (p?.gameweeks ?? [])
    // Vienen como "J6"; nos quedamos con el numero.
    .map((g) => Number.parseInt(String(g).replace(/\D/g, ''), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  const managers: ManagerProgression[] = []
  for (const u of p?.users ?? []) {
    const managerId = Number(u.user?.id_uc)
    if (!Number.isFinite(managerId) || managerId <= 0) continue
    const ranks = Object.entries(u.progression ?? {})
      .map(([j, r]) => ({ jornada: Number.parseInt(j, 10), rank: Math.round(Number(r)) }))
      .filter((x) => Number.isFinite(x.jornada) && Number.isFinite(x.rank) && x.rank > 0)
      .sort((a, b) => a.jornada - b.jornada)
    managers.push({ managerId, name: String(u.user?.name ?? ''), ranks })
  }

  return { jornadas, managers }
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
