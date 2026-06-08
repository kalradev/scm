import type { OvfMoneyUnit } from '../types/ovf'

export function parseOvfMoneyInput(raw: string | undefined | null): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

/**
 * INR amount for a charge field: absolute INR, or % of a base subtotal
 * (e.g. customer line sell or vendor line purchase, depending on context).
 */
export function extraChargeInrFromField(
  raw: string | undefined | null,
  unit: OvfMoneyUnit,
  percentBasisSubtotal: number,
): number {
  const v = parseOvfMoneyInput(raw)
  if (v === 0) return 0
  if (unit === 'inr') return v
  if (percentBasisSubtotal <= 0) return 0
  return (percentBasisSubtotal * v) / 100
}

/** Single-line summary for OVF HTML meta / exports. */
export function formatChargeFieldForMeta(
  raw: string,
  unit: OvfMoneyUnit,
  percentBasisSubtotal: number,
  formatInrFn: (n: number) => string,
  percentBasisLabel: 'line sell' | 'vendor purchase' = 'vendor purchase',
): string {
  const t = raw.trim()
  if (!t) return ''
  const inr = extraChargeInrFromField(raw, unit, percentBasisSubtotal)
  if (unit === 'percent') {
    return `${t}% of ${percentBasisLabel} (subtotal ${formatInrFn(percentBasisSubtotal)}) → ${formatInrFn(inr)} INR in tax base`
  }
  return `${formatInrFn(parseOvfMoneyInput(raw))} INR`
}
