import type { QuoteFinanceReviewState } from '../types/quotePipeline'
import type { QuoteFormData } from '../types/quotePdf'
import { quoteGrandTotalInr } from './quotePoMatch'

function parseMoney(raw: string | undefined): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

export type QuoteFinanceEconomicsResult = {
  sellTotal: number
  /** Sum of qty × vendor unit on quote lines (before invoice footer adjustments). */
  linePurchaseTotal: number
  /** Vendor cost basis for margin: net payable when invoice footer is stored, else line sum. */
  purchaseTotal: number
  marginInr: number
  marginPct: number | null
  hasVendorCosts: boolean
  /** True when `purchaseTotal` came from parsed invoice footer (`vendorNetPurchaseInr`). */
  usesInvoiceNetPurchase: boolean
  /** Deposit / credit from supplier invoice footer when captured. */
  vendorDepositInr: number | null
}

/**
 * Sell total comes from quoted unit prices. Purchase uses net vendor payable from the
 * invoice footer when stored on the quote (`vendorNetPurchaseInr`), otherwise the sum of
 * qty × vendor unit rate from lines.
 */
export function quoteFinanceEconomics(
  form: QuoteFormData,
  review?: Pick<
    QuoteFinanceReviewState,
    'vendorNetPurchaseInr' | 'vendorDepositInr'
  > | null,
): QuoteFinanceEconomicsResult {
  const sellTotal = quoteGrandTotalInr(form)
  let linePurchaseTotal = 0
  let hasLineRates = false
  for (const line of form.lineItems) {
    const vu = line.vendorUnitPrice
    if (vu === undefined || String(vu).trim() === '') continue
    const rate = parseMoney(vu)
    const qty = parseMoney(line.qty)
    if (!Number.isFinite(rate) || !Number.isFinite(qty)) continue
    hasLineRates = true
    linePurchaseTotal += qty * rate
  }

  let purchaseTotal = linePurchaseTotal
  const net = review?.vendorNetPurchaseInr
  let usesInvoiceNetPurchase = false
  if (typeof net === 'number' && Number.isFinite(net) && net >= 0) {
    purchaseTotal = net
    usesInvoiceNetPurchase = true
  }

  const dep = review?.vendorDepositInr
  const vendorDepositInr =
    typeof dep === 'number' && Number.isFinite(dep) && dep >= 0 ? dep : null

  const hasVendorCosts =
    hasLineRates ||
    (typeof net === 'number' && Number.isFinite(net) && net >= 0)

  const marginInr = sellTotal - purchaseTotal
  const marginPct =
    sellTotal > 0 && hasVendorCosts ? (marginInr / sellTotal) * 100 : null
  return {
    sellTotal,
    linePurchaseTotal,
    purchaseTotal,
    marginInr,
    marginPct,
    hasVendorCosts,
    usesInvoiceNetPurchase,
    vendorDepositInr,
  }
}
