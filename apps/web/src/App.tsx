import { useEffect, useState } from 'react'
import type { Diagnosis, Threat } from './types.ts'
import { fmt, fmtFull, fmtDate } from './format.ts'
import { Chat } from './Chat.tsx'

const TIER_LABEL: Record<number, string> = { 1: '+100%', 2: '+150%', 3: '+200%' }

export function App() {
  const [data, setData] = useState<Diagnosis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/state')
      .then(async (r) => {
        const body: unknown = await r.json()
        if (!r.ok) throw new Error((body as { error?: string }).error ?? `Error ${r.status}`)
        return body as Diagnosis
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return (
      <div className="wrap">
        <div className="state">
          <p>No se pudieron cargar los datos.</p>
          <p className="empty">{error}</p>
          <p className="empty">
            Si la ingesta no ha corrido nunca, lanza el workflow «Ingesta diaria» en GitHub.
          </p>
        </div>
      </div>
    )
  }

  if (!data) return <div className="wrap"><div className="state">Cargando…</div></div>

  const protegibles = data.threats.filter((t) => t.advice.action === 'subir')
  const expuestos = data.threats.filter((t) => t.advice.action === 'imposible')
  const cebos = data.threats.filter((t) => t.advice.action === 'cebo')

  return (
    <div className="wrap">
      <header className="top">
        <h1>Asesor MLS</h1>
        <span className="tag">Jornada {data.currentJornada}</span>
        <span className="when">Datos del {fmtDate(data.generatedAt)}</span>
      </header>
      <p className="lead">
        Gana quien más puntos acumule en 38 jornadas. El dinero solo es el medio.
      </p>

      <section>
        <h2>Tu situación</h2>
        <div className="cards">
          <div className="card">
            <div className="k">Clasificación</div>
            <div className="v">{data.self.rank}º</div>
            <div className="sub">
              {data.self.points} pts
              {data.self.pointsToLeader > 0 ? ` · a ${data.self.pointsToLeader} del líder` : ' · líder'}
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

      <section>
        <h2>Rivales · saldo reconstruido</h2>
        <div className="tablebox">
          <table>
            <thead>
              <tr>
                <th>Manager</th>
                <th className="num">Puntos</th>
                <th className="num">Equipo</th>
                <th className="num">Saldo estimado</th>
                <th className="num">Puede gastar</th>
              </tr>
            </thead>
            <tbody>
              {data.rivals.map((r) => (
                <tr key={r.managerId}>
                  <td>{r.name}</td>
                  <td className="num">{r.points}</td>
                  <td className="num">{fmt(r.teamValue)}</td>
                  <td className="num">
                    {r.balance.exact
                      ? fmt(r.balance.estimate)
                      : `${fmt(r.balance.low)} – ${fmt(r.balance.high)}`}
                  </td>
                  <td className="num"><b>{fmt(r.threatCapacity)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">
          Mister oculta el saldo ajeno en esta liga, así que se reconstruye a partir del
          historial de operaciones y del presupuesto inicial común de 50M. «Puede gastar»
          usa el escenario más rico de cada rival: al protegerte conviene equivocarse por
          prudencia.
        </div>
      </section>

      <section>
        <h2>Tus jugadores en peligro</h2>
        {protegibles.length === 0 && expuestos.length === 0 && (
          <p className="empty">Ningún jugador tuyo está hoy en riesgo real de clausulazo.</p>
        )}
        {protegibles.map((t) => <ThreatCard key={t.player.id} t={t} />)}
        {expuestos.slice(0, 5).map((t) => <ThreatCard key={t.player.id} t={t} />)}

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
            Plan recomendado: {data.protection.plan.map((p) => p.player.name).join(', ')}.
            Coste total {fmtFull(data.protection.totalCost)}.
          </div>
        )}
      </section>

      {cebos.length > 0 && (
        <section>
          <h2>Cebos · déjalos sin proteger a propósito</h2>
          {cebos.map((t) => <ThreatCard key={t.player.id} t={t} />)}
        </section>
      )}

      <section>
        <h2>Clausulazos recomendados</h2>
        {data.raids.length === 0 ? (
          <p className="empty">Hoy no hay ningún robo que salga a cuenta con tu capacidad actual.</p>
        ) : (
          <>
            <div className="tablebox">
              <table>
                <thead>
                  <tr>
                    <th>Jugador</th>
                    <th>Dueño</th>
                    <th className="num">Cláusula</th>
                    <th className="num">Vale</th>
                    <th className="num">Beneficio</th>
                    <th className="num">Retorno</th>
                  </tr>
                </thead>
                <tbody>
                  {data.raids.map((r) => (
                    <tr key={r.player.id}>
                      <td>{r.player.name}</td>
                      <td>{r.ownerName}</td>
                      <td className="num">{fmt(r.clause)}</td>
                      <td className="num">{fmt(r.sportingValue)}</td>
                      <td className="num"><b>{fmt(r.profit)}</b></td>
                      <td className="num">{(r.roi * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            {(['GK', 'DF', 'MF', 'FW'] as const).map((pos) => {
              const linea = data.lineup!.starters.filter((s) => s.position === pos)
              if (linea.length === 0) return null
              return (
                <div className="facts" key={pos} style={{ marginTop: 6 }}>
                  <span style={{ minWidth: 32 }}><b>{pos}</b></span>
                  <span>{linea.map((s) => `${s.name} (${s.expectedPoints})`).join(' · ')}</span>
                </div>
              )
            })}
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

      {data.deadweight.length > 0 && (
        <section>
          <h2>Lastre a vender</h2>
          {data.deadweight.map((d) => (
            <div className="item" key={d.playerId}>
              <h3>{d.name} <span className="tag">{fmt(d.value)}</span></h3>
              <p className="why">{d.reason}</p>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Pregúntale al asesor</h2>
        <Chat />
      </section>

      {data.warnings.length > 0 && (
        <section>
          <h2>Limitaciones de estos datos</h2>
          {data.warnings.map((w, i) => <div className="note warn" key={i}>{w}</div>)}
        </section>
      )}
    </div>
  )
}

/**
 * Una tarjeta por jugador amenazado. Muestra siempre las tres cifras que
 * sostienen la decision (clausula, lo que vale y lo que ganaria quien lo robe)
 * y el porque, para que la recomendacion se pueda discutir en vez de obedecer.
 */
function ThreatCard({ t }: { t: Threat }) {
  const cls = t.advice.action === 'cebo' ? 'cebo' : `risk-${t.risk}`
  return (
    <div className={`item ${cls}`}>
      <h3>
        {t.player.name}
        <span className={`tag ${t.advice.action === 'cebo' ? 'cebo' : t.risk}`}>
          {t.advice.action === 'cebo' ? 'cebo' : `riesgo ${t.risk}`}
        </span>
        {t.shielded && <span className="tag ok">blindado</span>}
      </h3>
      <div className="facts">
        <span>Cláusula <b>{fmt(t.clause)}</b></span>
        <span>Vale <b>{fmt(t.sportingValue)}</b></span>
        <span>Beneficio para quien lo robe <b>{fmt(t.raidProfit)}</b></span>
        {t.threats.length > 0 && (
          <span>Pueden pagarla: {t.threats.map((x) => x.name).join(', ')}</span>
        )}
      </div>
      {t.advice.action === 'subir' && t.advice.tier ? (
        <div className="action">
          Sube al tramo {TIER_LABEL[t.advice.tier]}: {fmt(t.clause)} → {fmt(t.advice.newClause ?? 0)}
          {' '}por {fmtFull(t.advice.cost ?? 0)}
        </div>
      ) : (
        <div className="action none">
          {t.advice.action === 'imposible' ? 'No se puede proteger' : 'Sin acción'}
        </div>
      )}
      <p className="why">{t.advice.rationale}</p>
    </div>
  )
}
