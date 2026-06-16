/** Scan plain text from an invoice for totals near the bottom (tax, grand total, balance due). */

export type ParsedInvoiceFooterAmounts = {
  /** Net payable when explicitly labelled (balance due / net payable). */
  balanceDue?: number
  /** Deposit / advance deducted on the invoice. */
  lessDeposit?: number
  /** Grand total including tax (e.g. "Total (INR)"). */
  totalInr?: number
  /** Tax total (e.g. "Total Tax Amount", IGST). */
  totalTaxAmount?: number
  /** Footer subtotal before tax. */
  subtotal?: number
}

function parseMoneyToken(raw: string): number | undefined {
  const cleaned = raw.replace(/[₹Rs\s]/gi, '').replace(/,/g, '').trim()
  if (!cleaned) return undefined
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : undefined
}

function lastAmountOnLine(line: string): number | undefined {
  const matches = line.match(/(?:₹|Rs\.?)?\s*[\d,]+(?:\.\d{1,2})?/gi)
  if (!matches?.length) return undefined
  const last = matches[matches.length - 1]
  return parseMoneyToken(last)
}

function amountNearLabel(lines: string[], i: number): number | undefined {
  let v = lastAmountOnLine(lines[i])
  if (v !== undefined) return v
  if (i + 1 < lines.length) {
    v = lastAmountOnLine(lines[i + 1])
    if (v !== undefined) return v
  }
  if (i - 1 >= 0) {
    v = lastAmountOnLine(lines[i - 1])
    if (v !== undefined) return v
  }
  return undefined
}

function isSubtotalLabel(low: string): boolean {
  return /\bsub\s*-?\s*total\b/i.test(low) && low.length < 100
}

function isTotalTaxLabel(low: string): number {
  if (/\btotal\s*tax\s*amount\b/i.test(low)) return 100
  if (/\btotal\s*tax\b/i.test(low)) return 90
  if (/\btotal\s*gst\b/i.test(low)) return 85
  if (/\btotal\s*igst\b/i.test(low)) return 85
  if (/\btax\s*amount\b/i.test(low) && /\btotal\b/i.test(low)) return 80
  if (/\bgst\s*amount\b/i.test(low) && !/\binr\s*gst\b/i.test(low)) return 40
  if (/\bigst\s*amount\b/i.test(low)) return 35
  if (/\btax\s*amount\b/i.test(low)) return 30
  return 0
}

function isGrandTotalLabel(low: string): boolean {
  if (isSubtotalLabel(low) || isTotalTaxLabel(low) > 0) return false
  if (/\b(total\s*tax|tax\s*amount)\b/i.test(low)) return false
  return (
    /\btotal\s*[\(\[]?\s*inr\s*[\)\]]?\b/i.test(low) ||
    /\bgrand\s*total\b/i.test(low) ||
    /\binvoice\s*total\b/i.test(low) ||
    /\bnet\s*amount\b/i.test(low) ||
    (/\btotal\s+amount\b/i.test(low) && !/\btax\b/i.test(low))
  )
}

/**
 * Looks for footer totals (subtotal, tax, grand total) and balance due / deposit lines.
 * Scans from the bottom of the document where summary rows usually appear.
 */
export function parseInvoiceFooterAmounts(raw: string): ParsedInvoiceFooterAmounts {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)

  let balanceDue: number | undefined
  let lessDeposit: number | undefined
  let totalInr: number | undefined
  let totalTaxAmount: number | undefined
  let subtotal: number | undefined
  let bestTaxScore = 0

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const low = line.toLowerCase()

    if (
      balanceDue === undefined &&
      /\b(balance\s*due|amount\s*due|net\s*payable|amount\s*payable|pay\s*balance)\b/i.test(
        low,
      )
    ) {
      const v = amountNearLabel(lines, i)
      if (v !== undefined) balanceDue = v
    }

    if (
      lessDeposit === undefined &&
      /\b(less\s*deposit|deposit\s*deducted|advance\s*adjusted|less\s*advance)\b/i.test(
        low,
      )
    ) {
      const v = amountNearLabel(lines, i)
      if (v !== undefined) lessDeposit = v
    }

    if (totalInr === undefined && isGrandTotalLabel(low)) {
      const v = amountNearLabel(lines, i)
      if (v !== undefined) totalInr = v
    }

    const taxScore = isTotalTaxLabel(low)
    if (taxScore > 0) {
      const v = amountNearLabel(lines, i)
      if (v !== undefined && taxScore >= bestTaxScore) {
        totalTaxAmount = v
        bestTaxScore = taxScore
      }
    }

    if (subtotal === undefined && isSubtotalLabel(low)) {
      const v = amountNearLabel(lines, i)
      if (v !== undefined) subtotal = v
    }
  }

  const footer: ParsedInvoiceFooterAmounts = {
    balanceDue,
    lessDeposit,
    totalInr,
    totalTaxAmount,
    subtotal,
  }
  return reconcileInvoiceFooterAmounts(footer)
}

/** When subtotal + tax ≠ grand, prefer the tax that matches the invoice math (one GST total). */
export function reconcileInvoiceFooterAmounts(
  footer: ParsedInvoiceFooterAmounts,
): ParsedInvoiceFooterAmounts {
  const sub = footer.subtotal
  const grand = footer.totalInr
  if (
    sub == null ||
    grand == null ||
    !Number.isFinite(sub) ||
    !Number.isFinite(grand) ||
    grand < sub
  ) {
    return footer
  }

  const impliedTax = grand - sub
  const parsedTax = footer.totalTaxAmount

  if (parsedTax == null || !Number.isFinite(parsedTax)) {
    if (impliedTax > 0.01) {
      return { ...footer, totalTaxAmount: impliedTax }
    }
    return footer
  }

  if (Math.abs(sub + parsedTax - grand) < 1.5) {
    return footer
  }

  if (Math.abs(impliedTax - parsedTax) > 0.02 && impliedTax > 0.01) {
    return { ...footer, totalTaxAmount: impliedTax }
  }

  return footer
}

/**
 * Best invoice grand total for display / purchase basis: balance due, then parsed
 * total (INR), then subtotal + tax, then line sum + tax, else line sum alone.
 */
export function resolveInvoiceGrandTotalInr(
  footer: ParsedInvoiceFooterAmounts,
  linePurchaseSum: number,
): number {
  if (
    footer.balanceDue !== undefined &&
    Number.isFinite(footer.balanceDue) &&
    footer.balanceDue >= 0
  ) {
    return footer.balanceDue
  }
  if (
    footer.totalInr !== undefined &&
    Number.isFinite(footer.totalInr) &&
    footer.totalInr >= 0
  ) {
    return footer.totalInr
  }
  if (
    footer.subtotal !== undefined &&
    footer.totalTaxAmount !== undefined &&
    Number.isFinite(footer.subtotal) &&
    Number.isFinite(footer.totalTaxAmount) &&
    footer.subtotal >= 0 &&
    footer.totalTaxAmount >= 0
  ) {
    return footer.subtotal + footer.totalTaxAmount
  }
  if (
    linePurchaseSum > 0 &&
    footer.totalTaxAmount !== undefined &&
    Number.isFinite(footer.totalTaxAmount) &&
    footer.totalTaxAmount >= 0
  ) {
    return linePurchaseSum + footer.totalTaxAmount
  }
  return linePurchaseSum
}

/**
 * Prefer explicit balance due; then grand total (incl. tax) from footer; otherwise
 * subtract stated deposit from line-sum purchase.
 */
export function computeVendorNetPurchaseInr(
  linePurchaseSum: number,
  footer: ParsedInvoiceFooterAmounts,
): { netPurchase?: number; deposit?: number } {
  const dep = footer.lessDeposit
  const hasDep = dep !== undefined && Number.isFinite(dep) && dep >= 0

  if (
    footer.balanceDue !== undefined &&
    Number.isFinite(footer.balanceDue) &&
    footer.balanceDue >= 0
  ) {
    return { netPurchase: footer.balanceDue, deposit: hasDep ? dep : undefined }
  }

  const grand = resolveInvoiceGrandTotalInr(footer, linePurchaseSum)
  const hasFooterTotal =
    (footer.totalInr !== undefined && footer.totalInr >= 0) ||
    (footer.totalTaxAmount !== undefined && footer.totalTaxAmount >= 0) ||
    (footer.subtotal !== undefined && footer.subtotal >= 0)

  if (hasFooterTotal && grand > 0) {
    const net = hasDep ? Math.max(0, grand - dep!) : grand
    return { netPurchase: net, deposit: hasDep ? dep : undefined }
  }

  if (hasDep && linePurchaseSum > 0) {
    return {
      netPurchase: Math.max(0, linePurchaseSum - dep!),
      deposit: dep,
    }
  }
  return {}
}
