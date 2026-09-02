/**
 * Todo el dinero del juego se maneja como enteros de euros.
 * Mister no usa decimales en ningun sitio, asi que number (double)
 * representa exactamente cualquier saldo por debajo de 2^53.
 */
export type Euros = number

export const M = (millones: number): Euros => Math.round(millones * 1_000_000)

/** "1.234.567" / "1.234.567 €" / "€1,234,567" -> 1234567 */
export function parseEuros(raw: string): Euros {
  const digits = raw.replace(/[^\d-]/g, '')
  if (digits === '' || digits === '-') return 0
  return Number.parseInt(digits, 10)
}

/** Mister espera los precios con puntos como separador de miles. */
export function formatMisterPrice(amount: Euros): string {
  return Math.round(amount).toLocaleString('de-DE')
}

/** Formato humano corto: 24.500.000 -> "24,5M" */
export function formatShort(amount: Euros): string {
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000
    const s = m >= 100 ? m.toFixed(0) : m.toFixed(1)
    return `${sign}${s.replace('.', ',')}M`
  }
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`
  return `${sign}${abs}`
}

/** Formato largo en es-ES: 24500000 -> "24.500.000 €" */
export function formatEuros(amount: Euros): string {
  return `${Math.round(amount).toLocaleString('es-ES')} €`
}
