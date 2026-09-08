import type { Diagnosis } from '../types.ts'
import { fmt, fmtFull } from '../format.ts'
import { PlayerAvatar } from '../PlayerAvatar.tsx'

/**
 * Las dos maneras de fichar, una detras de otra, porque compiten por el mismo
 * dinero: el mercado abierto y el clausulazo. Antes eran dos tablas de seis
 * columnas que en el movil solo se podian leer haciendo scroll lateral.
 */
export function Mercado({ data }: { data: Diagnosis }) {
  const buys = data.market?.buys ?? []

  return (
    <>
      <section>
        <h2>Fichajes del mercado abierto</h2>
        {buys.length === 0 ? (
          <p className="empty">
            Hoy el mercado no ofrece nada que mejore tu once con tu capacidad actual.
          </p>
        ) : (
          <div className="rows">
            {buys.map((b) => (
              <div className="row" key={b.playerId}>
                <PlayerAvatar id={b.playerId} name={b.name} />
                <div className="row-main">
                  <div className="row-n">
                    {b.name}
                    <span className="tag">{b.position}</span>
                  </div>
                  <div className="row-m">
                    +{b.pointsGained.toFixed(0)} pts · {fmt(b.costPerPoint)} por punto ·{' '}
                    {b.displaces ? `sienta a ${b.displaces}` : 'hueco libre'}
                  </div>
                </div>
                <div className="row-side">
                  <span className="price">{fmt(b.price)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Clausulazos recomendados</h2>
        <p className="note">
          {data.market?.bestCostPerPoint !== null && data.market !== undefined ? (
            <>
              El listón: hoy el punto más barato del mercado abierto es{' '}
              <b>{data.market.playerName}</b> a {fmt(data.market.price ?? 0)}, o sea{' '}
              <b>{fmt(Math.round(data.market.bestCostPerPoint))} por punto</b>. Un clausulazo solo
              compensa si baja de esa cifra.
            </>
          ) : (
            <>
              El mercado abierto no ofrece hoy nada que mejore tu once, así que no hay alternativa
              con la que comparar un clausulazo.
            </>
          )}
        </p>
        {data.raids.length === 0 ? (
          <p className="empty">
            Hoy no hay ningún robo que salga a cuenta con tu capacidad actual.
          </p>
        ) : (
          <>
            <div className="rows">
              {data.raids.map((r) => (
                <div className="row" key={r.player.id}>
                  <PlayerAvatar id={r.player.id} name={r.player.name} />
                  <div className="row-main">
                    <div className="row-n">{r.player.name}</div>
                    <div className="row-m">
                      de {r.ownerName} · +{r.gain.remaining.toFixed(0)} pts ·{' '}
                      {fmt(Math.round(r.costPerPoint))} por punto ·{' '}
                      {r.gain.displaces?.name ? `sienta a ${r.gain.displaces.name}` : 'hueco libre'}
                    </div>
                  </div>
                  <div className="row-side">
                    <span className="price">{fmt(r.clause)}</span>
                    <span className="row-sub">cláusula</span>
                  </div>
                </div>
              ))}
            </div>
            {data.raidPlan.plan.length > 0 && (
              <div className="note">
                Plan de hoy, respetando el límite de 3 cláusulas diarias y tu saldo:{' '}
                {data.raidPlan.plan.map((r) => `${r.player.name} (${fmt(r.clause)})`).join(', ')}.
                Coste total {fmtFull(data.raidPlan.totalCost)}.
              </div>
            )}
          </>
        )}
      </section>
    </>
  )
}
