/** Scan plain text from an invoice for totals near the bottom (balance due, deposits). */

function parseMoneyToken(raw: string): number | undefined {
  const cleaned = raw.replace(/[₹Rs.,\s]/gi, '').replace(/,/g, '').trim()
  if (!cleaned) return undefined
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Looks for balance due / net payable lines and less deposit lines (English labels).
 * Amount is usually the last number on the matched line.
 */
export function parseInvoiceFooterAmounts(raw: string): {
  balanceDue?: number
  lessDeposit?: number
} {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)

  let balanceDue: number | undefined
  let lessDeposit: number | undefined

  function lastAmountOnLine(line: string): number | undefined {
    const matches = line.match(/(?:₹|Rs\.?)?\s*[\d,]+(?:\.\d{1,2})?/gi)
    if (!matches?.length) return undefined
    const last = matches[matches.length - 1]
    return parseMoneyToken(last)
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const low = line.toLowerCase()

    if (
      balanceDue === undefined &&
      /\b(balance\s*due|amount\s*due|net\s*payable|amount\s*payable|pay\s*balance)\b/i.test(
        low,
      )
    ) {
      let v = lastAmountOnLine(line)
      if (v === undefined && i + 1 < lines.length) {
        v = lastAmountOnLine(lines[i + 1])
      }
      if (v !== undefined) balanceDue = v
    }

    if (
      lessDeposit === undefined &&
      /\b(less\s*deposit|deposit\s*deducted|advance\s*adjusted|less\s*advance)\b/i.test(
        low,
      )
    ) {
      let v = lastAmountOnLine(line)
      if (v === undefined && i + 1 < lines.length) {
        v = lastAmountOnLine(lines[i + 1])
      }
      if (v !== undefined) lessDeposit = v
    }
  }

  return { balanceDue, lessDeposit }
}

/**
 * Prefer explicit balance due; otherwise subtract stated deposit from line-sum purchase.
 */
export function computeVendorNetPurchaseInr(
  linePurchaseSum: number,
  footer: { balanceDue?: number; lessDeposit?: number },
): { netPurchase?: number; deposit?: number } {
  const dep = footer.lessDeposit
  if (
    footer.balanceDue !== undefined &&
    Number.isFinite(footer.balanceDue) &&
    footer.balanceDue >= 0
  ) {
    return { netPurchase: footer.balanceDue, deposit: dep }
  }
  if (
    dep !== undefined &&
    Number.isFinite(dep) &&
    dep >= 0 &&
    linePurchaseSum > 0
  ) {
    return {
      netPurchase: Math.max(0, linePurchaseSum - dep),
      deposit: dep,
    }
  }
  return {}
}
