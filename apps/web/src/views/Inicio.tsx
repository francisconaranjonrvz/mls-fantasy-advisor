import type { Diagnosis } from '../types.ts'
import { fmt, fmtFull } from '../format.ts'
import { PlayerAvatar } from '../PlayerAvatar.tsx'

const LINEAS = [
  ['GK', 'Portería'],
  ['DF', 'Defensa'],
  ['MF', 'Medio'],
  ['FW', 'Delantera'],
] as const

/**
 * La portada responde a «como voy y que hago hoy». Todo lo que exige comparar
 * cifras entre managers o repasar la plantilla entera vive en otra pestana.
 */
export function Inicio({ data }: { data: Diagnosis }) {
  const enPeligro = data.threats.filter(
    (t) => t.advice.action === 'subir' || t.advice.action === 'cobrar_mas',
  ).length

  return (
    <>
      <section>
        <h2>Tu situación</h2>
        <div className="cards">
          <div className="card">
            <div className="k">Clasificación</div>
            <div className="v">{data.self.rank}º</div>
            <div className="sub">
              {data.self.points} pts
              {data.self.pointsToLeader > 0
                ? ` · a ${data.self.pointsToLeader} del líder`
                : ' · líder'}
            </div>
          </div>
          <div className="card">
            <div className="k">Saldo</div>
            <div className="v">{fmt(data.self.balance)}</div>
            <div className="sub">{fmtFull(data.self.balance)}</div>
          </div>
          <div className="card">
            <div className="k">Puede gastar</div>
            <div className="v">{fmt(data.self.maxSpend)}</div>
            <div className="sub">saldo + 25% del equipo</div>
          </div>
          <div className="card">
            <div className="k">Valor de equipo</div>
            <div className="v">{fmt(data.self.teamValue)}</div>
            <div className="sub">{fmtFull(data.self.teamValue)}</div>
          </div>
        </div>

        {data.calibration && (
          <div className={`note${data.calibration.error === 0 ? '' : ' warn'}`}>
            {data.calibration.error === 0
              ? 'La reconstrucción de saldos reproduce exactamente tu saldo real, así que las estimaciones de los rivales son fiables.'
              : `La reconstrucción aplicada a tu propia cuenta se desvía ${fmt(data.calibration.error)} (${data.calibration.errorPct.toFixed(1)}%). Las estimaciones de los rivales arrastran ese mismo sesgo.`}
          </div>
        )}
      </section>

      {/* Lo accionable de hoy, resumido y con enlace a donde se explica. */}
      <section>
        <h2>Qué hacer hoy</h2>
        <div className="todo">
          <a className="todo-item" href="#plantilla">
            <span className="todo-n">{enPeligro}</span>
            <span className="todo-t">
              jugadores que puedes proteger
              <em>Subirles la cláusula los deja fuera del alcance del rival más rico.</em>
            </span>
          </a>
          <a className="todo-item" href="#mercado">
            <span className="todo-n">{data.raids.length}</span>
            <span className="todo-t">
              clausulazos que salen a cuenta
              <em>Cuestan menos por punto que lo más barato del mercado abierto.</em>
            </span>
          </a>
          <a className="todo-item" href="#mercado">
            <span className="todo-n">{data.market?.buys?.length ?? 0}</span>
            <span className="todo-t">
              fichajes que mejoran tu once
              <em>Del mercado abierto, con la capacidad de compra que tienes hoy.</em>
            </span>
          </a>
          <a className="todo-item" href="#plantilla">
            <span className="todo-n">{data.deadweight.length}</span>
            <span className="todo-t">
              jugadores de los que deshacerte
              <em>No entran en el once y su valor solo baja.</em>
            </span>
          </a>
        </div>
      </section>

      {data.lineup && (
        <section>
          <h2>Once recomendado</h2>
          <div className="item">
            <h3>
              {data.lineup.formation}
              <span className="tag">{data.lineup.expectedPoints} pts esperados</span>
              {data.lineup.emptySlots > 0 && (
                <span className="tag alto">{data.lineup.emptySlots} huecos</span>
              )}
            </h3>
            <div className="lineup">
              {LINEAS.map(([pos, etiqueta]) => {
                const linea = data.lineup!.starters.filter((s) => s.position === pos)
                if (linea.length === 0) return null
                return (
                  <div className="linea" key={pos}>
                    <div className="linea-k">{etiqueta}</div>
                    <div className="linea-p">
                      {linea.map((s) => (
                        <div className="starter" key={s.playerId}>
                          <PlayerAvatar id={s.playerId} name={s.name} size="sm" />
                          <span className="starter-n">{s.name}</span>
                          <span className="starter-p">{s.expectedPoints}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            {data.lineup.costOfNextBest > 0 && (
              <p className="why">
                El siguiente mejor dibujo rendiría {data.lineup.costOfNextBest} puntos menos.
              </p>
            )}
          </div>

          {data.lineup.emptySlots > 0 && (
            <div className="note warn">
              Quedan {data.lineup.emptySlots} huecos sin cubrir, que restan{' '}
              {Math.abs(data.lineup.penalty)} puntos. Merece la pena fichar aunque sea barato: un
              canterano de 160.000 evita ese −4.
            </div>
          )}

          {data.lineup.substitution && (
            <div className="note">
              Cambio durante la jornada (solo se permite uno):{' '}
              <b>{data.lineup.substitution.outName}</b> por{' '}
              <b>{data.lineup.substitution.inName}</b>, +{data.lineup.substitution.gain} puntos.{' '}
              {data.lineup.substitution.rationale}
            </div>
          )}
        </section>
      )}
    </>
  )
}
