import { describe, it, expect } from 'vitest'
import {
  parsePlayerRows, parseMarket, parseStandingsMembers, parseBalanceHistory,
  parseReason, parseTransactionType, parseMisterDate, parseCurrentJornada,
  toTransactions, movementsToTransactions, stripTags, refineBonus,
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

describe('libro de movimientos en JSON', () => {
  /** Forma real devuelta por /ajax/sw/balance, incluido el <span> en reason. */
  const MOVIMIENTOS = [
    {
      ts: 1788646303,
      adate: '06/09/2026 - 00:11',
      reason: 'Roberto Fernández <span>a</span> Rxul_2504',
      sign: '+',
      amount: 11872500,
      type: 'Venta por cláusula',
      balance: 11908692,
    },
    {
      ts: 1788500000,
      reason: 'Lamine Yamal <span>a</span> Mister',
      // Mister deja el signo VACIO en las salidas; no usa "-".
      sign: '',
      amount: 14200000,
      type: 'Compra',
      balance: 36192,
    },
  ]

  it('aplica el signo, que viene aparte del importe', () => {
    const txs = movementsToTransactions(MOVIMIENTOS, 4410)
    expect(txs[0]!.amount).toBe(11_872_500)
    expect(txs[1]!.amount).toBe(-14_200_000)
  })

  it('limpia el HTML incrustado en el motivo', () => {
    expect(stripTags('Roberto Fernández <span>a</span> Rxul_2504'))
      .toBe('Roberto Fernández a Rxul_2504')
  })

  it('extrae jugador y contraparte del motivo ya limpio', () => {
    const txs = movementsToTransactions(MOVIMIENTOS, 4410, (n) =>
      n === 'Rxul_2504' ? 999 : undefined,
    )
    expect(txs[0]!.playerName).toBe('Roberto Fernández')
    expect(txs[0]!.counterpartyId).toBe(999)
  })

  it('trata Mister como mercado y no como rival', () => {
    const txs = movementsToTransactions(MOVIMIENTOS, 4410, () => 123)
    expect(txs[1]!.counterpartyId).toBeUndefined()
  })

  it('traduce las etiquetas en espanol de Mister', () => {
    const txs = movementsToTransactions(MOVIMIENTOS, 4410)
    expect(txs[0]!.type).toBe('buyout_sale')
    expect(txs[1]!.type).toBe('purchase')
  })

  it('prefiere la marca de tiempo unix a la fecha ya formateada', () => {
    const txs = movementsToTransactions(MOVIMIENTOS, 4410)
    expect(txs[0]!.date).toBe(new Date(1788646303 * 1000).toISOString())
  })

  it('conserva el saldo resultante, que permite verificar la reconstruccion', () => {
    expect(movementsToTransactions(MOVIMIENTOS, 4410)[0]!.balanceAfter).toBe(11_908_692)
  })
})

describe('mercado: donde vive el id del jugador', () => {
  /**
   * Regresion. El parser buscaba el id en .player-pic y el mercado salia
   * siempre vacio, aunque la pagina real traia 43 jugadores. El contenedor
   * existia; el atributo estaba en .player-avatar, como en el resto de vistas.
   */
  it('lo encuentra en .player-avatar', () => {
    const html = '<ul id="list-on-sale"><li data-price="8400000">' +
      '<div class="player-avatar" data-id_player="777"></div></li></ul>'
    expect(parseMarket(html)[0]?.playerId).toBe(777)
  })

  it('sigue aceptando .player-pic, por si convive el marcado antiguo', () => {
    const html = '<ul id="list-on-sale"><li data-price="100">' +
      '<div class="player-pic" data-id_player="888"></div></li></ul>'
    expect(parseMarket(html)[0]?.playerId).toBe(888)
  })

  it('ignora una fila sin id en vez de inventarse uno', () => {
    expect(parseMarket('<ul id="list-on-sale"><li data-price="100"></li></ul>')).toHaveLength(0)
  })
})

describe('el signo de los movimientos, tal como lo codifica Mister', () => {
  /**
   * Comprobado contra la cuenta real: Mister marca las ENTRADAS con "+" y las
   * salidas con una cadena VACIA. La comparacion original era contra "-", que
   * no acierta nunca, asi que las 19 compras del historial se guardaban en
   * positivo y el saldo reconstruido se inflaba en decenas de millones.
   */
  const mov = (type: string, sign: string, amount = 1_000_000) => ({ type, sign, amount, ts: 1 })

  it('trata como entrada solo lo que lleva un "+" explicito', () => {
    expect(movementsToTransactions([mov('Venta', '+')], 1)[0]!.amount).toBe(1_000_000)
    expect(movementsToTransactions([mov('Bonificación', '+')], 1)[0]!.amount).toBe(1_000_000)
  })

  it('trata el signo vacio como salida, que es como Mister marca las compras', () => {
    expect(movementsToTransactions([mov('Compra', '')], 1)[0]!.amount).toBe(-1_000_000)
    expect(movementsToTransactions([mov('Penalización', '')], 1)[0]!.amount).toBe(-1_000_000)
  })

  it('un signo ausente tambien es salida, no una entrada por descuido', () => {
    expect(movementsToTransactions([{ type: 'Compra', amount: 500 }], 1)[0]!.amount).toBe(-500)
  })

  it('reconoce "Compra por clausula", que es como Mister llama al clausulazo pagado', () => {
    expect(movementsToTransactions([mov('Compra por cláusula', '')], 1)[0]!.type)
      .toBe('buyout_signing')
  })

  it('los seis tipos reales del historial se reconocen, ninguno cae en unknown', () => {
    const reales = [
      'Compra', 'Venta', 'Bonificación', 'Penalización',
      'Compra por cláusula', 'Venta por cláusula',
    ]
    for (const t of reales) {
      expect(movementsToTransactions([mov(t, '')], 1)[0]!.type).not.toBe('unknown')
    }
  })
})

describe('las tres cosas que Mister llama "Bonificacion"', () => {
  /**
   * Los importes son los de la cuenta real, no inventados. Es importante:
   * la regla que los separa se apoya en las cotas del reglamento, y solo se
   * puede confiar en ella si casa con lo que el servidor manda de verdad.
   */
  it('el apunte de varios millones del principio es el saldo inicial', () => {
    expect(refineBonus('bonus', 12_472_000)).toBe('seed')
  })

  it('los importes de 1,0M a 1,5M son la bonificacion de jornada', () => {
    expect(refineBonus('bonus', 1_200_000)).toBe('bonus')
    expect(refineBonus('bonus', 1_050_000)).toBe('bonus')
  })

  it('los multiplos pequenos de 25.000 son la quiniela', () => {
    // 100.000 son cuatro aciertos; 150.000, seis.
    expect(refineBonus('bonus', 100_000)).toBe('quiniela')
    expect(refineBonus('bonus', 150_000)).toBe('quiniela')
  })

  it('no toca lo que no es una bonificacion', () => {
    expect(refineBonus('purchase', 100_000)).toBe('purchase')
    expect(refineBonus('sale', 12_472_000)).toBe('sale')
  })

  it('un cargo negativo no puede ser ninguna de las tres', () => {
    expect(refineBonus('bonus', -100_000)).toBe('bonus')
  })

  it('clasifica una jornada completa tal cual llega del servidor', () => {
    const txs = movementsToTransactions(
      [
        { ts: 1755439994, type: 'Bonificacion', sign: '+', amount: 12_472_000, balance: 12_472_000 },
        { ts: 1756115983, type: 'Bonificacion', sign: '+', amount: 1_200_000, balance: 13_672_000 },
        { ts: 1756116009, type: 'Bonificacion', sign: '+', amount: 100_000, balance: 13_772_000 },
      ],
      1,
    )
    expect(txs.map((t) => t.type)).toEqual(['seed', 'bonus', 'quiniela'])
  })
})
