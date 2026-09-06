import { describe, it, expect } from 'vitest'
import { parseFeedTransfers, feedTransfersToTransactions } from './parse-html.ts'

/** Estructura real de una tarjeta de traspaso, comprobada contra la liga. */
const tarjeta = (opts: {
  playerId: number
  name: string
  title: string
  from?: { id: number; slug: string }
  to?: { id: number; slug: string }
  price: string
}) => `
<div class="card card-transfer" id="c-${opts.playerId}" data-comments="0">
  <ul class="player-list player-list--secondary">
    <li>
      <div class="item">
        <div class="title">${opts.title}</div>
        <div class="player-row">
          <a class="btn btn-sw-link player" href="/players/${opts.playerId}">
            <div class="player-avatar player-avatar--md" data-id_player="${opts.playerId}"></div>
            <div class="info"><div class="name">${opts.name}</div></div>
          </a>
          <div class="flow">
            ${opts.from
              ? `<a class="btn btn-sw-link avatar user" href="users/${opts.from.id}/${opts.from.slug}"><div class="user-avatar user-avatar--xs"></div></a>`
              : '<div class="avatar"><div class="user-avatar user-avatar--xs"></div></div>'}
            <svg><use href="#arrow"></use></svg>
            ${opts.to
              ? `<a class="btn btn-sw-link avatar user" href="users/${opts.to.id}/${opts.to.slug}"><div class="user-avatar user-avatar--xs"></div></a>`
              : '<div class="avatar"><div class="user-avatar user-avatar--xs"></div></div>'}
            <div class="price">${opts.price}</div>
          </div>
        </div>
      </div>
    </li>
  </ul>
</div>`

describe('traspasos del feed de actividad', () => {
  const entreManagers = tarjeta({
    playerId: 12900, name: 'Vinicius', title: 'Traspaso',
    from: { id: 111, slug: 'paquito' }, to: { id: 222, slug: 'cuggito' },
    price: '18.400.000',
  })

  it('extrae jugador, ambas partes e importe', () => {
    const [t] = parseFeedTransfers(entreManagers)
    expect(t!.playerId).toBe(12900)
    expect(t!.playerName).toBe('Vinicius')
    expect(t!.fromManagerId).toBe(111)
    expect(t!.toManagerId).toBe(222)
    expect(t!.price).toBe(18_400_000)
  })

  it('reconoce a Mister como parte sin pagina propia', () => {
    const delMercado = tarjeta({
      playerId: 777, name: 'Canterano', title: 'Fichaje',
      to: { id: 222, slug: 'cuggito' }, price: '160.000',
    })
    const [t] = parseFeedTransfers(delMercado)
    expect(t!.fromManagerId).toBeUndefined()
    expect(t!.toManagerId).toBe(222)
  })

  it('ignora una tarjeta sin jugador identificable', () => {
    expect(parseFeedTransfers('<div class="card card-transfer"><div class="item"></div></div>'))
      .toHaveLength(0)
  })

  it('lee varias tarjetas de un mismo feed', () => {
    expect(parseFeedTransfers(entreManagers + entreManagers)).toHaveLength(2)
  })
})

describe('traspasos convertidos en movimientos', () => {
  const at = '2026-09-06T05:00:00.000Z'

  it('un traspaso entre managers genera dos apuntes simetricos', () => {
    const transfers = parseFeedTransfers(tarjeta({
      playerId: 1, name: 'X', title: 'Traspaso',
      from: { id: 111, slug: 'a' }, to: { id: 222, slug: 'b' }, price: '10.000.000',
    }))
    const txs = feedTransfersToTransactions(transfers, at)
    expect(txs).toHaveLength(2)
    // Quien entrega ingresa; quien recibe paga.
    expect(txs.find((t) => t.managerId === 111)!.amount).toBe(10_000_000)
    expect(txs.find((t) => t.managerId === 222)!.amount).toBe(-10_000_000)
  })

  it('los importes de un traspaso suman cero entre las dos partes', () => {
    const transfers = parseFeedTransfers(tarjeta({
      playerId: 1, name: 'X', title: 'Traspaso',
      from: { id: 111, slug: 'a' }, to: { id: 222, slug: 'b' }, price: '7.500.000',
    }))
    const total = feedTransfersToTransactions(transfers, at).reduce((a, t) => a + t.amount, 0)
    expect(total).toBe(0)
  })

  it('una compra al mercado genera un solo apunte, porque Mister no es un rival', () => {
    const transfers = parseFeedTransfers(tarjeta({
      playerId: 1, name: 'X', title: 'Fichaje', to: { id: 222, slug: 'b' }, price: '160.000',
    }))
    const txs = feedTransfersToTransactions(transfers, at)
    expect(txs).toHaveLength(1)
    expect(txs[0]!.managerId).toBe(222)
    expect(txs[0]!.amount).toBe(-160_000)
  })

  it('distingue un clausulazo de una compra normal por el titulo', () => {
    const transfers = parseFeedTransfers(tarjeta({
      playerId: 1, name: 'X', title: 'Pago de cláusula',
      from: { id: 111, slug: 'a' }, to: { id: 222, slug: 'b' }, price: '24.000.000',
    }))
    const txs = feedTransfersToTransactions(transfers, at)
    expect(txs.find((t) => t.managerId === 222)!.type).toBe('buyout_signing')
    expect(txs.find((t) => t.managerId === 111)!.type).toBe('buyout_sale')
  })

  it('una compra normal no se marca como clausulazo', () => {
    const transfers = parseFeedTransfers(tarjeta({
      playerId: 1, name: 'X', title: 'Traspaso',
      from: { id: 111, slug: 'a' }, to: { id: 222, slug: 'b' }, price: '5.000.000',
    }))
    expect(feedTransfersToTransactions(transfers, at).map((t) => t.type).sort())
      .toEqual(['purchase', 'sale'])
  })
})
