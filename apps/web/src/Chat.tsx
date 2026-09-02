import { useState, useRef, useEffect } from 'react'
import type { ChatTurn } from './types.ts'

const SUGGESTIONS = [
  '¿A quién le subo la cláusula esta semana?',
  '¿Qué clausulazo me sale más a cuenta?',
  '¿A quién debería vender?',
  '¿Voy bien de saldo para la próxima jornada?',
]

/**
 * El asistente recibe el diagnostico ya calculado, asi que no inventa cifras:
 * las cita. Por eso el chat es para discutir el plan, no para pedirle cuentas.
 */
export function Chat() {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])

  async function send(text: string) {
    const message = text.trim()
    if (!message || busy) return

    const history = turns.slice(-10)
    setTurns((t) => [...t, { role: 'user', content: message }])
    setInput('')
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      })
      const data = (await res.json()) as { text?: string; error?: string; detail?: string }
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
      setTurns((t) => [...t, { role: 'assistant', content: data.text ?? '(respuesta vacía)' }])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat">
      <div className="log" ref={logRef}>
        {turns.length === 0 && !busy && (
          <p className="empty">
            Pregúntale lo que quieras. Conoce el contrato, el reglamento y el estado real de
            la liga, y los números se los da el motor ya calculados.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            <div className="who">{t.role === 'user' ? 'Tú' : 'Asesor'}</div>
            <div className="msg">{t.content}</div>
          </div>
        ))}
        {busy && (
          <div className="turn assistant">
            <div className="who">Asesor</div>
            <div className="msg">Pensando…</div>
          </div>
        )}
        {error && <div className="note warn">{error}</div>}
      </div>

      {turns.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => void send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pregunta sobre la liga…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Enviar
        </button>
      </form>
    </div>
  )
}
