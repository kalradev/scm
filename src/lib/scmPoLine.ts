import type { ScmPoLine } from '../types/scmPo'

export const SCM_PO_TYPE_OPTIONS = ['Goods', 'Services', 'Other'] as const

/** GST / tax % presets on SCM PO line items (India common slabs). */
export const SCM_PO_TAX_PERCENT_OPTIONS = ['0', '5', '12', '18', '28'] as const

export function defaultPoType(): string {
  return SCM_PO_TYPE_OPTIONS[0]
}

/**
 * PO "Item details" is usually product + description. When Sales copies the same
 * text into both fields, join would duplicate it — show a single line instead.
 */
export function mergeQuoteProductAndDescriptionForItemDetails(
  product: string,
  description: string,
): string {
  const p = product.trim()
  const d = description.trim()
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (!p && !d) return ''
  if (!p) return description.trim()
  if (!d) return p
  if (collapse(p) === collapse(d)) return p
  return `${p}\n${d}`.trim()
}

/**
 * Older PO drafts stored product + description as two lines even when identical.
 * Collapse consecutive duplicate lines so preview/editor/export show one line.
 */
export function dedupeItemDetailsRepeatedLines(raw: string): string {
  const text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    const prev = out[out.length - 1]
    if (prev !== undefined && norm(prev) === norm(trimmed)) continue
    out.push(trimmed)
  }
  return out.join('\n').trim()
}

/** Map stored or imported text to the nearest allowed PO tax %. */
export function normalizeScmPoLineTaxPct(raw: string | undefined | null): string {
  const t = String(raw ?? '')
    .trim()
    .replace(/,/g, '')
    .replace(/^(\d+(?:\.\d+)?)\s*%$/i, '$1')
  if ((SCM_PO_TAX_PERCENT_OPTIONS as readonly string[]).includes(t)) return t
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return '18'
  const allowed = [0, 5, 12, 18, 28]
  let best: (typeof allowed)[number] = 18
  let bestDiff = Infinity
  for (const a of allowed) {
    const d = Math.abs(a - n)
    if (d < bestDiff) {
      bestDiff = d
      best = a
    }
  }
  return String(best)
}

/** Merge legacy `description`-only rows into the expanded line shape. */
export function normalizeScmPoLine(
  raw: Partial<ScmPoLine> & { id: string; description?: string },
): ScmPoLine {
  const legacy = String(raw.description ?? '').trim()
  const itemDetails = dedupeItemDetailsRepeatedLines(
    String(raw.itemDetails ?? '').trim() || legacy,
  )
  const poTypeRaw = String(raw.poType ?? '').trim()
  const poType = (SCM_PO_TYPE_OPTIONS as readonly string[]).includes(poTypeRaw)
    ? poTypeRaw
    : defaultPoType()
  return {
    id: raw.id,
    itemDetails,
    partNumber: String(raw.partNumber ?? '').trim(),
    hsnCode: String(raw.hsnCode ?? '').trim(),
    poType,
    quantity: String(raw.quantity ?? '').trim(),
    rate: String(raw.rate ?? '').trim(),
    distributionPct: String(raw.distributionPct ?? '').trim(),
    tax: normalizeScmPoLineTaxPct(raw.tax),
  }
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Pre‑tax line value: qty × unit rate. */
export function computeLineSubtotalInr(qty: string, rate: string): number {
  return parseMoney(qty) * parseMoney(rate)
}

/** Tax amount on line (qty × rate × tax%). */
export function computeLineTaxAmountInr(
  qty: string,
  rate: string,
  taxPct: string,
): number {
  const sub = computeLineSubtotalInr(qty, rate)
  return sub * (parseMoney(taxPct) / 100)
}

/** Subtotal + tax% on subtotal (qty × rate × (1 + tax/100)). */
export function computeLineTotalInr(qty: string, rate: string, taxPct: string): number {
  const sub = computeLineSubtotalInr(qty, rate)
  return sub + computeLineTaxAmountInr(qty, rate, taxPct)
}

export function formatInrScm(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
