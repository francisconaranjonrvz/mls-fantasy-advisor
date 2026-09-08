import type { PlayerDetail, RawOwnerRecord } from './endpoints.ts'

/**
 * El reparto inicial, que era el ultimo dato que se suponia.
 *
 * La caja de partida de cada manager es el presupuesto menos lo que valia la
 * plantilla que le tocaron. Sin ese numero el saldo de un rival no es una suma
 * sino un intervalo, y ese intervalo era el que hacia inutil la mitad del
 * analisis: "puede gastar entre 0 y 12M" no permite decidir nada.
 *
 * Se puede saber exacto, y la ficha del jugador trae las dos piezas:
 *
 *  1. `owners`, la cadena de traspasos. Lo importante es lo que NO aparece:
 *     el reparto de principio de temporada no genera registro. Mathew Ryan es
 *     mio, nunca lo compre, y su cadena esta vacia.
 *
 *  2. `values_chart`, el valor de mercado dia a dia un anno hacia atras. Con el
 *     los jugadores repartidos se valoran al precio que tenian el dia del
 *     reparto en lugar de al de hoy. Tres semanas de mercado movian a Ryan de
 *     9.084.000 a 9.901.000, y ese sesgo iba a parar entero a la caja inicial.
 *
 * Contra la cuenta propia, donde la caja inicial se conoce por el libro, el
 * metodo da 37.528.000 de plantilla y por tanto 12.472.000 de caja: exactamente
 * lo observado, sin un euro de diferencia.
 */

const MESES: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, sept: 8, oct: 9, nov: 10, dic: 11,
}

/**
 * Convierte "17 ago 2026" a "2026-08-17".
 *
 * Mister escribe las fechas de estos dos campos en castellano abreviado, y no
 * siempre igual: septiembre viene como "sept" y el resto con tres letras.
 */
export function parseSpanishDate(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{1,2})\s+([a-zA-ZáéíóúÁÉÍÓÚ]+)\.?\s+(\d{4})/.exec(raw)
  if (!m) return null
  const mes = MESES[m[2]!.toLowerCase()]
  if (mes === undefined) return null
  const dia = Number(m[1])
  if (!Number.isFinite(dia) || dia < 1 || dia > 31) return null
  const d = String(dia).padStart(2, '0')
  const mm = String(mes + 1).padStart(2, '0')
  return `${m[3]}-${mm}-${d}`
}

/** La cadena de traspasos ordenada de mas antigua a mas reciente. */
export function ownerChain(detail: PlayerDetail): RawOwnerRecord[] {
  const raw = Array.isArray(detail.owners) ? detail.owners : []
  // Por id de traspaso, que es creciente. La fecha tiene precision de dia y
  // dentro de un mismo dia no distingue, que es justo cuando importa el orden.
  return [...raw].sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))
}

/**
 * A quien le toco este jugador en el reparto. 0 si a nadie.
 *
 * `currentOwnerId` hace falta porque el caso mas comun -el jugador que sigue
 * en la plantilla a la que fue repartido- no deja ningun rastro en `owners`.
 */
export function draftOwner(detail: PlayerDetail, currentOwnerId: number): number {
  const cadena = ownerChain(detail)
  if (cadena.length === 0) return currentOwnerId > 0 ? currentOwnerId : 0
  const primero = cadena[0]!
  const de = Number(primero.id_uc_from ?? 0)
  // id_uc_from 0 es Mister: el jugador estaba libre al empezar la temporada.
  return Number.isFinite(de) && de > 0 ? de : 0
}

/**
 * Valor de mercado del jugador en una fecha (YYYY-MM-DD).
 *
 * Si ese dia exacto no esta, se coge el ultimo anterior: el valor solo cambia
 * cuando Mister lo revaloriza, asi que arrastrar el previo es correcto y no
 * una aproximacion. Devuelve null si la serie no llega tan atras, que es
 * distinto de valer cero y hay que poder distinguirlo.
 */
export function valueOn(detail: PlayerDetail, isoDate: string): number | null {
  const puntos = detail.values_chart?.points
  if (!Array.isArray(puntos) || puntos.length === 0) return null

  let mejor: { fecha: string; valor: number } | null = null
  for (const p of puntos) {
    const fecha = parseSpanishDate(p?.date)
    const valor = Number(p?.value)
    if (fecha === null || !Number.isFinite(valor)) continue
    if (fecha > isoDate) continue
    if (!mejor || fecha > mejor.fecha) mejor = { fecha, valor }
  }
  return mejor ? Math.round(mejor.valor) : null
}

export interface DraftPlayer {
  playerId: number
  managerId: number
  /** Valor el dia del reparto. */
  value: number
  /** Si sigue en la plantilla a la que fue repartido. */
  retained: boolean
}

export interface DraftReconstruction {
  /** Valor de la plantilla repartida, por manager. */
  valueByManager: Record<string, number>
  players: DraftPlayer[]
  /** Jugadores cuyo valor en la fecha del reparto no se pudo leer. */
  missingValue: number[]
}

/**
 * Reconstruye el reparto de toda la liga.
 *
 * `details` es la ficha de cada jugador que pudo haber sido repartido: los que
 * hoy tiene alguien, mas los que aparecen en cualquier traspaso del feed
 * (porque uno repartido y vendido ya no figura en ninguna plantilla).
 */
export function reconstructDraft(
  details: Map<number, PlayerDetail>,
  currentOwner: Map<number, number>,
  draftDate: string,
): DraftReconstruction {
  const valueByManager: Record<string, number> = {}
  const players: DraftPlayer[] = []
  const missingValue: number[] = []

  for (const [playerId, detail] of details) {
    const dueno = draftOwner(detail, currentOwner.get(playerId) ?? 0)
    if (dueno <= 0) continue

    const valor = valueOn(detail, draftDate)
    if (valor === null) {
      missingValue.push(playerId)
      continue
    }

    valueByManager[String(dueno)] = (valueByManager[String(dueno)] ?? 0) + valor
    players.push({
      playerId,
      managerId: dueno,
      value: valor,
      retained: ownerChain(detail).length === 0,
    })
  }

  return { valueByManager, players, missingValue }
}
