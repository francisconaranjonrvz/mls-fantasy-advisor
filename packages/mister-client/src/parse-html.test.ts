import { describe, it, expect } from 'vitest'
import {
  parsePlayerRows, parseMarket, parseStandingsMembers, parseBalanceHistory,
  parseReason, parseTransactionType, parseMisterDate, parseCurrentJornada,
  toTransactions,
} from './parse-html.ts'
import { extractXAuth, extractLeagueId } from './auth.ts'
import {
  TEAM_HTML, MARKET_HTML, STANDINGS_HTML, BALANCE_HTML, MARKET_PAGE_WITH_AUTH,
} from './__fixtures__/html.ts'

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

describe('deteccion del id de liga', () => {
  /**
   * Regresion de un fallo real en produccion. La regex antigua devolvia "1"
   * porque enganchaba un id_competition que no era el de la liga. Ese "1"
   * viajaba luego en la cabecera x-league de todas las llamadas a /ajax/sw, y
   * el servidor no respondia con un error: devolvia vacio. El sintoma aparecia
   * mucho mas lejos, como un catalogo sin jugadores y las diez plantillas
   * rivales ilegibles, sin nada que apuntase a la causa.
   */
  it('descarta un id implausible en vez de propagarlo a la cabecera x-league', () => {
    expect(extractLeagueId('<script>var cfg={"id_competition":1,"foo":2}</script>')).toBeNull()
    expect(extractLeagueId('{"community":{"id":"3"}}')).toBeNull()
  })

  it('prefiere un id real aunque aparezca despues de uno implausible', () => {
    const html = '<script>{"id_competition":1}</script><a href="/action/change?id_community=1263883">'
    expect(extractLeagueId(html)).toBe('1263883')
  })

  it('lo encuentra en un enlace de cambio de liga', () => {
    expect(extractLeagueId('<a href="/action/change?id_community=987654">Mi liga</a>')).toBe('987654')
  })

  it('devuelve null si no hay ninguno, para poder avisar en vez de inventarlo', () => {
    expect(extractLeagueId('<html><body>nada</body></html>')).toBeNull()
  })
})

describe('numero de jornada', () => {
  /**
   * Regresion: data-gwid es el identificador GLOBAL de jornada de Mister, no el
   * numero de jornada de liga. Contra la cuenta real valia 4045 y se colaba en
   * el diagnostico, descuadrando todo lo que depende de cuantas jornadas se han
   * jugado.
   */
  it('descarta un gwid que no puede ser un numero de jornada', () => {
    expect(parseCurrentJornada('<div data-gwid="4045"></div>')).toBeNull()
  })

  it('prefiere el numero visible al identificador interno', () => {
    const html = '<div class="gameweek" data-gwid="4045"><span>JORNADA 6</span></div>'
    expect(parseCurrentJornada(html)).toBe(6)
  })

  it('acepta un gwid plausible cuando no hay numero visible', () => {
    expect(parseCurrentJornada('<div data-gwid="6"></div>')).toBe(6)
  })

  it('no acepta una jornada 39, que no existe', () => {
    expect(parseCurrentJornada('<span>JORNADA 39</span>')).toBeNull()
  })
})
