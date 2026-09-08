import type { Diagnosis } from '../types.ts'
import { fmt } from '../format.ts'

/**
 * La clasificacion incluye tu propia fila. Antes la tabla listaba solo a los
 * rivales, y para saber si ibas por delante de uno habia que ir a buscar tu
 * puesto a la portada. Aqui se ve de un vistazo, con tu fila marcada como hace
 * Mister con la suya.
 */
export function Tabla({ data }: { data: Diagnosis }) {
  const filas = [
    {
      id: data.self.managerId,
      name: data.self.name,
      points: data.self.points,
      teamValue: data.self.teamValue,
      balance: fmt(data.self.balance),
      spend: data.self.maxSpend,
      self: true,
    },
    ...data.rivals.map((r) => ({
      id: r.managerId,
      name: r.name,
      points: r.points,
      teamValue: r.teamValue,
      // Cuando el saldo no se puede fijar al euro se dice la horquilla entera,
      // que es la verdad, en vez de un punto medio con pinta de exacto.
      balance: r.balance.exact
        ? fmt(r.balance.estimate)
        : `${fmt(r.balance.low)} – ${fmt(r.balance.high)}`,
      spend: r.threatCapacity,
      self: false,
    })),
  ].sort((a, b) => b.points - a.points)

  return (
    <section>
      <h2>Clasificación · saldo reconstruido</h2>
      <div className="rows">
        {filas.map((f, i) => (
          <div className={`row${f.self ? ' row--self' : ''}`} key={f.id}>
            <span className="rank">{i + 1}</span>
            <div className="row-main">
              <div className="row-n">{f.name}</div>
              <div className="row-m">
                {f.points} pts · equipo {fmt(f.teamValue)} · saldo {f.balance}
              </div>
            </div>
            <div className="row-side">
              <span className="price">{fmt(f.spend)}</span>
              <span className="row-sub">puede gastar</span>
            </div>
          </div>
        ))}
      </div>
      <div className="note">
        Mister oculta el saldo ajeno en esta liga, así que se reconstruye a partir del historial
        de operaciones y del presupuesto inicial común de 50M. «Puede gastar» usa el escenario más
        rico de cada rival: al protegerte conviene equivocarse por prudencia.
      </div>
    </section>
  )
}
