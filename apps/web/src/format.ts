/** Formato corto: 24.500.000 -> "24,5M". Es como se habla de dinero en la liga. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000
    return `${sign}${(m >= 100 ? m.toFixed(0) : m.toFixed(1)).replace('.', ',')}M`
  }
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`
  return `${sign}${abs}`
}

export function fmtFull(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${Math.round(n).toLocaleString('es-ES')} €`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
