import { useEffect, useState } from 'react'
import type { Diagnosis } from './types.ts'
import { fmt, fmtDate } from './format.ts'
import { Inicio } from './views/Inicio.tsx'
import { Plantilla } from './views/Plantilla.tsx'
import { Mercado } from './views/Mercado.tsx'
import { Tabla } from './views/Tabla.tsx'
import { Asesor } from './views/Asesor.tsx'

/**
 * Las cinco secciones y su icono. El orden imita al de Mister, que es donde el
 * usuario ya tiene el dedo acostumbrado: primero como voy, luego mi plantilla,
 * luego en que gastar, luego contra quien compito.
 */
const TABS = [
  { id: 'inicio', label: 'Inicio', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
  { id: 'plantilla', label: 'Plantilla', icon: 'M9 3 4 5.5V10h3v11h10V10h3V5.5L15 3a3 3 0 0 1-6 0Z' },
  { id: 'mercado', label: 'Mercado', icon: 'M3 8h13l-3-3m8 11H8l3 3' },
  { id: 'tabla', label: 'Tabla', icon: 'M7 4h10v5a5 5 0 0 1-10 0V4ZM4 5h3M17 5h3M9 20h6M12 14v6' },
  { id: 'asesor', label: 'Asesor', icon: 'M21 12a8 8 0 1 1-3.2-6.4M12 8v4M12 16h.01' },
] as const

type TabId = (typeof TABS)[number]['id']

const DEFAULT_TAB: TabId = 'inicio'

function isTab(v: string): v is TabId {
  return TABS.some((t) => t.id === v)
}

/**
 * La seccion vive en el hash de la URL en vez de en un estado suelto, de modo
 * que se puede compartir un enlace directo al mercado, el boton de atras del
 * navegador funciona y recargar no te devuelve a la portada. Es lo que daria un
 * router, sin la dependencia.
 */
function useTab(): TabId {
  const read = () => {
    const h = window.location.hash.slice(1)
    return isTab(h) ? h : DEFAULT_TAB
  }
  const [tab, setTab] = useState<TabId>(read)
  useEffect(() => {
    const on = () => {
      setTab(read())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return tab
}

export function App() {
  const [data, setData] = useState<Diagnosis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tab = useTab()

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

  useEffect(() => {
    const t = TABS.find((x) => x.id === tab)
    document.title = tab === DEFAULT_TAB ? 'Asesor MLS' : `${t?.label} | Asesor MLS`
  }, [tab])

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

  if (!data) {
    return (
      <div className="wrap">
        <div className="state">Cargando…</div>
      </div>
    )
  }

  return (
    <>
      {/*
        La barra fija es la de Mister: la marca a la izquierda y, a la derecha,
        las dos cifras que uno mira cada dos minutos. Vive fuera de .wrap para
        poder ocupar todo el ancho.
      */}
      <div className="appbar">
        <div className="inner">
          <span className="brand">
            Asesor<em>MLS</em>
          </span>
          <div className="pills">
            <span className="pill">
              <span className="u">€</span>
              {fmt(data.self.balance)}
            </span>
            <span className="pill">
              {data.self.points}
              <span className="u">pts</span>
            </span>
          </div>
        </div>
      </div>

      <nav className="tabs" aria-label="Secciones">
        <div className="inner">
          {TABS.map((t) => (
            <a
              key={t.id}
              className={`tab${t.id === tab ? ' on' : ''}`}
              href={`#${t.id}`}
              aria-current={t.id === tab ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={t.icon} />
              </svg>
              {t.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="wrap">
        <header className="top">
          <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
          <span className="tag">Jornada {data.currentJornada}</span>
          <span className="when">Datos del {fmtDate(data.generatedAt)}</span>
        </header>
        {tab === DEFAULT_TAB && (
          <p className="status">
            {data.self.rank}º con {data.self.points} pts
            {data.self.pointsToLeader > 0
              ? ` · a ${data.self.pointsToLeader} del líder`
              : ' · líder'}
          </p>
        )}
        <p className="lead">Gana quien más puntos acumule en 38 jornadas. El dinero solo es el medio.</p>

        {tab === 'inicio' && <Inicio data={data} />}
        {tab === 'plantilla' && <Plantilla data={data} />}
        {tab === 'mercado' && <Mercado data={data} />}
        {tab === 'tabla' && <Tabla data={data} />}
        {tab === 'asesor' && <Asesor data={data} />}
      </div>
    </>
  )
}
