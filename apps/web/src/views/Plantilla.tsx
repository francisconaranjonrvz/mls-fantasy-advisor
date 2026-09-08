import type { Diagnosis } from '../types.ts'
import { fmt, fmtFull } from '../format.ts'
import { ThreatCard } from '../ThreatCard.tsx'
import { PlayerAvatar } from '../PlayerAvatar.tsx'

/** Todo lo que se decide mirando la plantilla propia: proteger, cebar, vender. */
export function Plantilla({ data }: { data: Diagnosis }) {
  const protegibles = data.threats.filter(
    (t) => t.advice.action === 'subir' || t.advice.action === 'cobrar_mas',
  )
  const expuestos = data.threats.filter((t) => t.advice.action === 'imposible')
  const cebos = data.threats.filter((t) => t.advice.action === 'cebo')

  return (
    <>
      <section>
        <h2>Tus jugadores en peligro</h2>
        {protegibles.length === 0 && expuestos.length === 0 && (
          <p className="empty">Ningún jugador tuyo está hoy en riesgo real de clausulazo.</p>
        )}
        {protegibles.map((t) => (
          <ThreatCard key={t.player.id} t={t} />
        ))}
        {expuestos.slice(0, 5).map((t) => (
          <ThreatCard key={t.player.id} t={t} />
        ))}

        {expuestos.length > 5 && (
          <div className="note">
            Y {expuestos.length - 5} jugadores más que tampoco se pueden poner fuera del alcance
            del rival más rico ni subiendo al tramo máximo. Con ellos la única alternativa es
            venderlos tú o asumir el robo y cobrar la cláusula.
          </div>
        )}

        {data.uncertainCount > 0 && (
          <div className="note">
            Otros {data.uncertainCount} jugadores tuyos no están confirmados como seguros, pero
            tampoco consta que nadie pueda pagarles la cláusula. Esa duda viene de que Mister
            oculta el saldo ajeno, no de una amenaza real: se estrechará en cuanto la ingesta
            capture el feed de movimientos de los rivales.
          </div>
        )}

        {data.protection.plan.length > 0 && (
          <div className="note">
            Plan recomendado: {data.protection.plan.map((p) => p.player.name).join(', ')}. Coste
            total {fmtFull(data.protection.totalCost)}.
          </div>
        )}
      </section>

      {cebos.length > 0 && (
        <section>
          <h2>Cebos · déjalos sin proteger a propósito</h2>
          {cebos.map((t) => (
            <ThreatCard key={t.player.id} t={t} />
          ))}
        </section>
      )}

      <section>
        <h2>Lastre a vender</h2>
        {data.deadweight.length === 0 ? (
          <p className="empty">No hay ningún jugador que sobre claramente en la plantilla.</p>
        ) : (
          data.deadweight.map((d) => (
            <div className="item" key={d.playerId}>
              <div className="item-head">
                <PlayerAvatar id={d.playerId} name={d.name} />
                <div className="item-title">
                  <h3>
                    {d.name}
                    <span className="tag">{fmt(d.value)}</span>
                  </h3>
                  <p className="why">{d.reason}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </section>
    </>
  )
}
