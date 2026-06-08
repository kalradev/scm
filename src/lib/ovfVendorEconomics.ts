import type { OvfFormFields } from '../types/ovf'
import type { QuoteLineForm } from '../types/quotePdf'
import { lineAmount } from './quotePdfTemplate'

function parseQty(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Same rules as quote unit price input. */
export function sanitizeVendorPurchaseUnit(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const i = cleaned.indexOf('.')
  let intPart: string
  let frac: string | undefined
  if (i === -1) {
    intPart = cleaned
    frac = undefined
  } else {
    intPart = cleaned.slice(0, i)
    frac = cleaned.slice(i + 1).replace(/\./g, '')
  }

  const hasFraction = frac !== undefined
  let intNorm = intPart.replace(/^0+/, '')
  if (intNorm === '') {
    if (intPart === '' && !hasFraction) return ''
    intNorm = '0'
  }
  if (frac === undefined) return intNorm
  return `${intNorm}.${frac}`
}

export function normalizeVendorPurchaseMap(
  fields: OvfFormFields,
): Record<string, string> {
  return fields.vendorPurchaseUnitByLineId &&
    typeof fields.vendorPurchaseUnitByLineId === 'object'
    ? { ...fields.vendorPurchaseUnitByLineId }
    : {}
}

export function hasAnyVendorPurchase(
  lines: QuoteLineForm[],
  vendorByLine: Record<string, string>,
): boolean {
  return lines.some((ln) => String(vendorByLine[ln.id] ?? '').trim() !== '')
}

export type OvfLineEconomics = {
  sellTotal: number
  vendorUnitDisplay: string
  purchaseTotal: number | null
  marginInr: number | null
  marginPctOnSale: number | null
}

export function computeLineEconomics(
  line: QuoteLineForm,
  vendorUnitRaw: string | undefined,
): OvfLineEconomics {
  const sellTotal = lineAmount(line)
  const v = String(vendorUnitRaw ?? '').trim()
  if (v === '') {
    return {
      sellTotal,
      vendorUnitDisplay: '',
      purchaseTotal: null,
      marginInr: null,
      marginPctOnSale: null,
    }
  }
  const vu = parseMoney(v)
  const qty = parseQty(line.qty)
  const purchaseTotal = qty * vu
  // OVF "margin" is defined as: (customer line total) - (vendor spend).
  const marginInr = sellTotal - purchaseTotal
  const marginPctOnSale =
    sellTotal > 0 ? (marginInr / sellTotal) * 100 : null
  return {
    sellTotal,
    vendorUnitDisplay: v,
    purchaseTotal,
    marginInr,
    marginPctOnSale,
  }
}

export type OvfAggregateEconomics = {
  /** Sum of commercial line totals (customer). */
  totalSell: number
  /** Sum of purchase amounts where vendor unit was entered. */
  totalPurchase: number
  totalMarginInr: number
  /** Overall margin % on summed sell for lines that have vendor purchase. */
  marginPctOnAttributedSell: number | null
  lineRows: OvfLineEconomics[]
}

export function computeOvfAggregateEconomics(
  lines: QuoteLineForm[],
  vendorByLine: Record<string, string>,
): OvfAggregateEconomics {
  let totalSell = 0
  let totalPurchase = 0
  let totalMarginInr = 0
  let sellAttributed = 0
  const lineRows: OvfLineEconomics[] = []

  for (const ln of lines) {
    const eco = computeLineEconomics(ln, vendorByLine[ln.id])
    lineRows.push(eco)
    totalSell += eco.sellTotal
    if (eco.purchaseTotal != null) {
      totalPurchase += eco.purchaseTotal
      sellAttributed += eco.sellTotal
      totalMarginInr += eco.marginInr ?? 0
    }
  }

  const marginPctOnAttributedSell =
    sellAttributed > 0 ? (totalMarginInr / sellAttributed) * 100 : null

  return {
    totalSell,
    totalPurchase,
    totalMarginInr,
    marginPctOnAttributedSell,
    lineRows,
  }
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Margin / margin % shown in Vendor section and OVF HTML meta.
 * Uses vendor economics when any line has vendor purchase; otherwise stored fields (legacy manual).
 */
export function getOvfMarginDisplayStrings(
  fields: OvfFormFields,
  lines: QuoteLineForm[],
  agg: OvfAggregateEconomics,
  vendorExtrasInr: number = 0,
): { margin: string; marginPercent: string } {
  const map = normalizeVendorPurchaseMap(fields)
  if (!hasAnyVendorPurchase(lines, map)) {
    const m = fields.margin.trim()
    const p = fields.marginPercent.trim()
    return {
      margin: m || '—',
      marginPercent: p || '—',
    }
  }
  const totalSell = agg.totalSell
  const marginInr = totalSell - (agg.totalPurchase + vendorExtrasInr)
  const marginPct = totalSell > 0 ? (marginInr / totalSell) * 100 : null
  return {
    margin: formatInr(marginInr),
    marginPercent:
      marginPct != null ? `${marginPct.toFixed(2)}%` : '—',
  }
}
