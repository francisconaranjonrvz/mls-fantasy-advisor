import type { Threat } from './types.ts'
import { fmt, fmtFull } from './format.ts'
import { PlayerAvatar } from './PlayerAvatar.tsx'

const TIER_LABEL: Record<number, string> = { 1: '+100%', 2: '+150%', 3: '+200%' }

/**
 * Una tarjeta por jugador amenazado. Muestra siempre las tres cifras que
 * sostienen la decision (clausula, lo que vale y lo que ganaria quien lo robe)
 * y el porque, para que la recomendacion se pueda discutir en vez de obedecer.
 */
export function ThreatCard({ t }: { t: Threat }) {
  const cls = t.advice.action === 'cebo' ? 'cebo' : `risk-${t.risk}`
  return (
    <div className={`item ${cls}`}>
      <div className="item-head">
        <PlayerAvatar id={t.player.id} name={t.player.name} />
        <div className="item-title">
          <h3>
            {t.player.name}
            <span className={`tag ${t.advice.action === 'cebo' ? 'cebo' : t.risk}`}>
              {t.advice.action === 'cebo' ? 'cebo' : `riesgo ${t.risk}`}
            </span>
            {t.shielded && <span className="tag ok">blindado</span>}
          </h3>
          <div className="facts">
            <span>
              Cláusula <b>{fmt(t.clause)}</b>
            </span>
            {/*
              Antes aqui ponia «Vale» y se pintaba el valor deportivo, que es cosa
              del modelo, no de Mister. Al lado de una clausula en euros se leia
              como el valor de mercado, y no cuadraba con la ficha del jugador:
              Mister decia 570.000 y aqui salia 2,7M. Son dos cifras distintas y
              ahora se dicen las dos, cada una con su nombre.
            */}
            <span>
              Valor <b>{fmt(t.player.value)}</b>
            </span>
            <span>
              Rinde como <b>{fmt(t.sportingValue)}</b>
            </span>
            <span>
              Beneficio para quien lo robe <b>{fmt(t.raidProfit)}</b>
            </span>
            {t.threats.length > 0 && (
              <span>Pueden pagarla: {t.threats.map((x) => x.name).join(', ')}</span>
            )}
          </div>
        </div>
      </div>
      {(t.advice.action === 'subir' || t.advice.action === 'cobrar_mas') && t.advice.tier ? (
        <div className="action">
          Sube al tramo {TIER_LABEL[t.advice.tier]}: {fmt(t.clause)} →{' '}
          {fmt(t.advice.newClause ?? 0)} por {fmtFull(t.advice.cost ?? 0)}
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
