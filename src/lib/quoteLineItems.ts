import type { QuoteLineForm } from '../types/quotePdf'

function parseQty(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Row has no commercial content (omit from PDF / preview / Excel). */
export function lineItemIsBlank(line: QuoteLineForm): boolean {
  const p = (line.product || '').trim()
  const d = (line.description || '').trim()
  if (p || d) return false
  return parseQty(line.qty) === 0 && parseMoney(line.unitPrice) === 0
}

/** User entered something on this row — it must be completed to save. */
export function lineItemIsStarted(line: QuoteLineForm): boolean {
  return !lineItemIsBlank(line)
}

/** Started row has product, description, quantity > 0, and unit price > 0. */
export function lineItemIsComplete(line: QuoteLineForm): boolean {
  if (lineItemIsBlank(line)) return true
  const p = (line.product || '').trim()
  const d = (line.description || '').trim()
  const q = parseQty(line.qty)
  const u = parseMoney(line.unitPrice)
  return Boolean(p && d && q > 0 && u > 0)
}

export function filterCommercialLines(
  lines: QuoteLineForm[],
): QuoteLineForm[] {
  return lines.filter((l) => !lineItemIsBlank(l))
}

/** `null` if OK; otherwise a single user-facing sentence. */
export function lineItemsSaveValidationMessage(
  lines: QuoteLineForm[],
): string | null {
  const started = lines.filter(lineItemIsStarted)
  if (started.length === 0) {
    return 'Add at least one full line item: product, description, quantity (more than zero), and unit price (more than zero).'
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!lineItemIsStarted(line)) continue
    if (!lineItemIsComplete(line)) {
      return `Line ${i + 1} is incomplete: add the full description plus product, quantity above zero, and unit price above zero — or clear the row (empty product and description, quantity and price at zero) so it is ignored.`
    }
  }
  return null
}
