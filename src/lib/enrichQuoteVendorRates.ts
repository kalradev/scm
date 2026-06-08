import {
  extractInvoiceLineItemsFromFile,
  extractInvoiceRawTextForFooterScan,
} from './extractInvoiceLineItems'
import type { ExtractedInvoiceLine } from './extractInvoiceLineItems'
import {
  computeVendorNetPurchaseInr,
  parseInvoiceFooterAmounts,
} from './invoiceFooterAmounts'
import { quoteFinanceEconomics } from './quoteFinanceEconomics'
import type { QuoteFinanceReviewState } from '../types/quotePipeline'
import type { QuoteFormData } from '../types/quotePdf'
import type { OvfProofAttachment } from '../types/ovf'
import { resolveAttachmentBase64 } from './attachmentIdb'

async function attachmentToFile(att: OvfProofAttachment): Promise<File> {
  const raw = await resolveAttachmentBase64(att.dataBase64)
  const bin = atob(raw)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: att.mimeType || 'application/octet-stream' })
  return new File([blob], att.fileName || 'invoice', {
    type: att.mimeType || 'application/octet-stream',
  })
}

function normalizeQtyKey(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, '').replace(/,/g, '').trim()
}

/**
 * Copies vendor unit rates from extracted invoice lines onto quote rows (imported lines
 * first, by row order; then qty match for remaining gaps).
 */
export function mergeExtractedVendorRatesIntoForm(
  form: QuoteFormData,
  extracted: ExtractedInvoiceLine[],
): QuoteFormData {
  if (!extracted.length) return form

  const next = form.lineItems.map((l) => ({ ...l }))
  const importedIdx = next
    .map((l, i) => (l.invoiceImported ? i : -1))
    .filter((i): i is number => i >= 0)

  const usedExtract = new Set<number>()

  for (let k = 0; k < importedIdx.length && k < extracted.length; k++) {
    const vu = extracted[k].vendorUnitPrice
    if (vu === undefined || !String(vu).trim()) continue
    const idx = importedIdx[k]
    next[idx] = { ...next[idx], vendorUnitPrice: vu }
    usedExtract.add(k)
  }

  for (let i = 0; i < next.length; i++) {
    const cur = next[i].vendorUnitPrice
    if (cur !== undefined && String(cur).trim() !== '') continue
    const qKey = normalizeQtyKey(next[i].qty)
    if (!qKey) continue

    for (let k = 0; k < extracted.length; k++) {
      if (usedExtract.has(k)) continue
      const vu = extracted[k].vendorUnitPrice
      if (vu === undefined || !String(vu).trim()) continue
      const ek = normalizeQtyKey(extracted[k].qty)
      if (ek !== qKey) continue
      next[i] = { ...next[i], vendorUnitPrice: vu }
      usedExtract.add(k)
      break
    }
  }

  return { ...form, lineItems: next }
}

/**
 * Re-parses the attached supplier invoice and merges vendor unit rates onto line items
 * for Finance margin / purchase totals.
 */
export async function enrichQuoteFormWithVendorAttachment(
  form: QuoteFormData,
  attachment: OvfProofAttachment,
): Promise<QuoteFormData> {
  const file = await attachmentToFile(attachment)
  const res = await extractInvoiceLineItemsFromFile(file)
  if (!res.ok || !res.lines.length) return form
  return mergeExtractedVendorRatesIntoForm(form, res.lines)
}

/** Balance due / deposit from invoice footer + line-sum purchase → net payable for Finance. */
export async function computeQuoteFinanceReviewExtras(
  enrichedForm: QuoteFormData,
  attachment: OvfProofAttachment,
): Promise<Partial<QuoteFinanceReviewState>> {
  const file = await attachmentToFile(attachment)
  const text = await extractInvoiceRawTextForFooterScan(file)
  const footer = parseInvoiceFooterAmounts(text)
  const lineSum = quoteFinanceEconomics(enrichedForm).linePurchaseTotal
  const { netPurchase, deposit } = computeVendorNetPurchaseInr(lineSum, footer)
  const patch: Partial<QuoteFinanceReviewState> = {}
  if (netPurchase !== undefined) patch.vendorNetPurchaseInr = netPurchase
  if (deposit !== undefined) patch.vendorDepositInr = deposit
  return patch
}
