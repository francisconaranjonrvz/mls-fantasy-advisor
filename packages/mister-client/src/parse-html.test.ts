import { describe, it, expect } from 'vitest'
import {
  parsePlayerRows, parseMarket, parseStandingsMembers, parseBalanceHistory,
  parseReason, parseTransactionType, parseMisterDate, parseCurrentJornada,
  toTransactions,
} from './parse-html.js'
import { extractXAuth, extractLeagueId } from './auth.js'
import {
  TEAM_HTML, MARKET_HTML, STANDINGS_HTML, BALANCE_HTML, MARKET_PAGE_WITH_AUTH,
} from './__fixtures__/html.js'

describe('parsePlayerRows', () => {
  const players = parsePlayerRows(TEAM_HTML)

  it('extrae todas las filas de jugador', () => {
    expect(players).toHaveLength(3)
  })

  it('lee id, nombre, valor y puntos', () => {
    const vini = players[0]!
    expect(vini.id).toBe(12900)
    expect(vini.name).toBe('Vinicius Junior')
    expect(vini.value).toBe(18_400_000)
    expect(vini.points).toBe(54)
  })

  it('mapea el codigo de posicion de Mister', () => {
    expect(players[0]!.position).toBe('FW')
    expect(players[1]!.position).toBe('DF')
    expect(players[2]!.position).toBe('GK')
  })

  it('lee la tendencia del valor', () => {
    expect(players[0]!.trend).toBe('up')
    expect(players[1]!.trend).toBe('down')
    expect(players[2]!.trend).toBe('flat')
  })

  it('detecta lesionados', () => {
    expect(players[1]!.status).toBe('injured')
    expect(players[0]!.status).toBe('ok')
  })

  it('detecta al jugador que ya no esta en LaLiga y por tanto no puntua', () => {
    expect(players[2]!.hasTeam).toBe(false)
    expect(players[0]!.hasTeam).toBe(true)
  })
})

describe('parseMarket', () => {
  const market = parseMarket(MARKET_HTML)

  it('extrae precio e id de mercado', () => {
    expect(market).toHaveLength(2)
    expect(market[0]!.playerId).toBe(10024)
    expect(market[0]!.price).toBe(8_400_000)
    expect(market[0]!.marketId).toBe('m-771')
  })

  it('distingue lo que saca Mister de lo que vende un rival', () => {
    expect(market[0]!.sellerId).toBeUndefined()
    expect(market[1]!.sellerId).toBe(4412)
  })
})

describe('parseStandingsMembers', () => {
  it('extrae los miembros sin duplicar', () => {
    const members = parseStandingsMembers(STANDINGS_HTML)
    expect(members).toHaveLength(3)
    expect(members.map((m) => m.id)).toEqual([4410, 4411, 4412])
    expect(members[1]!.slug).toBe('el-mister-loco')
  })
})

describe('parseBalanceHistory', () => {
  const entries = parseBalanceHistory(BALANCE_HTML)

  it('lee las cuatro entradas', () => {
    expect(entries).toHaveLength(4)
  })

  it('conserva el signo del importe', () => {
    expect(entries[0]!.amount).toBe(-14_200_000)
    expect(entries[1]!.amount).toBe(24_000_000)
    expect(entries[3]!.amount).toBe(-2_400_000)
  })

  it('lee el saldo resultante, que permite verificar la reconstruccion', () => {
    expect(entries[1]!.balanceAfter).toBe(27_100_000)
  })

  it('convierte la fecha a ISO', () => {
    expect(entries[0]!.date).toBe('2026-09-12T05:00:00')
  })
})

describe('parseTransactionType', () => {
  it('acepta etiquetas en ingles y en espanol', () => {
    expect(parseTransactionType('Purchase')).toBe('purchase')
    expect(parseTransactionType('Compra')).toBe('purchase')
    expect(parseTransactionType('Buyout sale')).toBe('buyout_sale')
  })

  it('trata Penalizacion como modificacion de clausula', () => {
    expect(parseTransactionType('Penalizacion')).toBe('clause_change')
    expect(parseTransactionType('Penalización')).toBe('clause_change')
  })

  it('degrada a unknown en vez de reventar', () => {
    expect(parseTransactionType('Algo Nuevo De Mister')).toBe('unknown')
  })
})

describe('parseReason', () => {
  it('separa jugador y contraparte', () => {
    expect(parseReason('Pedri to Paquito')).toEqual({
      playerName: 'Pedri',
      counterpartyName: 'Paquito',
    })
  })

  it('trata Mister como mercado, no como rival', () => {
    expect(parseReason('Lamine Yamal to Mister').counterpartyName).toBeUndefined()
  })

  it('extrae el jugador de una modificacion de clausula', () => {
    expect(parseReason('Modificacion de clausula (150%) de Jorge de Frutos')).toEqual({
      playerName: 'Jorge de Frutos',
    })
  })

  it('usa la ultima " a " para no partir nombres que la contienen', () => {
    expect(parseReason('Raul de Tomas a Paquito')).toEqual({
      playerName: 'Raul de Tomas',
      counterpartyName: 'Paquito',
    })
  })
})

describe('toTransactions', () => {
  it('resuelve la contraparte a un id de manager', () => {
    const txs = toTransactions(parseBalanceHistory(BALANCE_HTML), 4410, (name) =>
      name === 'Paquito' ? 4412 : undefined,
    )
    expect(txs[1]!.counterpartyId).toBe(4412)
    expect(txs[1]!.type).toBe('buyout_sale')
    expect(txs[0]!.counterpartyId).toBeUndefined()
  })
})

describe('extraccion de sesion', () => {
  it('encuentra el token X-Auth en el script inline', () => {
    expect(extractXAuth(MARKET_PAGE_WITH_AUTH)).toBe('6baca5339d20a40b459ad851692e643f')
  })

  it('encuentra el id de liga', () => {
    expect(extractLeagueId(MARKET_PAGE_WITH_AUTH)).toBe('1263883')
  })

  it('devuelve null si Mister cambia el formato, en vez de inventarse un token', () => {
    expect(extractXAuth('<html><script>var x = 1;</script></html>')).toBeNull()
  })
})

describe('misc', () => {
  it('lee la jornada en curso', () => {
    expect(parseCurrentJornada(TEAM_HTML)).toBe(6)
  })

  it('devuelve null ante una fecha con formato desconocido', () => {
    expect(parseMisterDate('ayer')).toBeNull()
  })
})
