import { getQuoteMoneySummary } from './quotePdfTemplate'
import type { QuoteFormData } from '../types/quotePdf'
import type { QuotePoState } from '../types/quotePo'

function parseInr(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

export function quoteGrandTotalInr(data: QuoteFormData): number {
  return getQuoteMoneySummary(data).total
}

/** Whether PO total and quote total agree (paise-level). */
export function poTotalsMatch(
  formSnapshot: QuoteFormData,
  po: QuotePoState | undefined,
): boolean {
  if (!po) return false
  const q = quoteGrandTotalInr(formSnapshot)
  const p = parseInr(po.poTotalInr)
  if (!Number.isFinite(p)) return false
  return Math.abs(q - p) < 0.01
}

export type PoMatchLabel = 'none' | 'matched' | 'mismatch'

export function poMatchLabel(
  formSnapshot: QuoteFormData,
  po: QuotePoState | undefined,
): PoMatchLabel {
  if (!po || !String(po.poTotalInr).trim()) return 'none'
  if (!Number.isFinite(parseInr(po.poTotalInr))) return 'none'
  return poTotalsMatch(formSnapshot, po) ? 'matched' : 'mismatch'
}
