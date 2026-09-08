import type { Diagnosis } from '../types.ts'
import { Chat } from '../Chat.tsx'

/**
 * El chat y, debajo, lo que el diagnostico no puede saber. Van juntos a
 * proposito: quien pregunta merece tener a la vista de que pie cojean las
 * respuestas.
 */
export function Asesor({ data }: { data: Diagnosis }) {
  return (
    <>
      <section>
        <h2>Pregúntale al asesor</h2>
        <Chat />
      </section>

      {data.warnings.length > 0 && (
        <section>
          <h2>Limitaciones de estos datos</h2>
          {data.warnings.map((w, i) => (
            <div className="note warn" key={i}>
              {w}
            </div>
          ))}
        </section>
      )}
    </>
  )
}
