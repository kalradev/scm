import { normalizeQuoteFormData } from './quoteFormDefaults'
import { poMatchLabel } from './quotePoMatch'
import type { QuoteFormData } from '../types/quotePdf'
import type { SavedQuoteRecord } from './savedQuotesStorage'

/** Rows created from invoice import attach `quoteFinanceReview` on finalize. */
export function usesInvoiceQuotePipeline(record: SavedQuoteRecord | null | undefined): boolean {
  return Boolean(record?.quoteFinanceReview)
}

export function effectiveQuoteFinanceStatus(
  record: SavedQuoteRecord | null | undefined,
): 'none' | 'pending_finance' | 'finance_approved' | 'finance_rejected' {
  const s = record?.quoteFinanceReview?.workflowStatus
  if (
    s === 'pending_finance' ||
    s === 'finance_approved' ||
    s === 'finance_rejected'
  ) {
    return s
  }
  return 'none'
}

export function effectivePoFinanceStatus(
  record: SavedQuoteRecord | null | undefined,
): 'none' | 'pending_finance' | 'finance_approved' | 'finance_rejected' {
  const s = record?.poFinanceReview?.workflowStatus
  if (
    s === 'pending_finance' ||
    s === 'finance_approved' ||
    s === 'finance_rejected'
  ) {
    return s
  }
  return 'none'
}

/** Customer PO upload / PO page reached only after quote finance approved & “sent” flag. */
export function canSalesAccessCustomerPoStep(record: SavedQuoteRecord): boolean {
  if (!usesInvoiceQuotePipeline(record)) return true
  if (record.quoteFinanceReview?.workflowStatus !== 'finance_approved') return false
  return Boolean(record.customerQuoteShipment?.sentToCustomerAt)
}

/**
 * When Sales may open the OVF screen: legacy quotes need PO totals matching the quote; invoice-import
 * quotes need Finance to approve the customer PO (GST) — that approval supersedes strict total match.
 */
export function canSalesCreateOvf(record: SavedQuoteRecord): boolean {
  if (usesInvoiceQuotePipeline(record)) {
    return record.poFinanceReview?.workflowStatus === 'finance_approved'
  }
  const form = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  return poMatchLabel(form, record.po) === 'matched'
}

/** Sales list: use the OVF commercial pipeline row after PO totals match, or after Finance approves the PO (invoice path). */
export function salesOvfWorkflowAfterPoGate(record: SavedQuoteRecord): boolean {
  const form = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  if (poMatchLabel(form, record.po) === 'matched') return true
  return (
    usesInvoiceQuotePipeline(record) &&
    effectivePoFinanceStatus(record) === 'finance_approved'
  )
}

/** Eye preview on Sales opens OVF when one exists and the PO gate is cleared for the OVF workflow. */
export function salesEyePreviewPrefersOvf(record: SavedQuoteRecord): boolean {
  return salesOvfWorkflowAfterPoGate(record) && Boolean(record.ovf)
}

export function invoicePipelineNoticeForSales(
  record: SavedQuoteRecord,
): string | null {
  const qs = effectiveQuoteFinanceStatus(record)
  if (qs === 'pending_finance') {
    return 'Finance is reviewing this quote and vendor invoice. You can preview or download the quote PDF meanwhile.'
  }
  if (qs === 'finance_rejected') {
    const note = record.quoteFinanceReview?.financeRejectionNote?.trim()
    return note
      ? `Finance rejected this quote: ${note}`
      : 'Finance rejected this quote. Open the row for details.'
  }
  if (qs === 'finance_approved' && !record.customerQuoteShipment?.sentToCustomerAt) {
    return 'Quote approved — use “Sent to customer” before uploading the customer PO.'
  }
  const ps = effectivePoFinanceStatus(record)
  if (record.po && poMatchedForRecord(record) && ps === 'pending_finance') {
    return 'Finance is verifying the customer PO (GST). You can still preview quote or PO from this row.'
  }
  if (ps === 'finance_rejected') {
    const note = record.poFinanceReview?.financeRejectionNote?.trim()
    return note
      ? `Finance rejected the customer PO: ${note}`
      : 'Finance rejected the customer PO. Submit again after correcting.'
  }
  if (
    poMatchedForRecord(record) &&
    ps === 'finance_approved' &&
    !record.ovf
  ) {
    return 'Finance approved the customer PO — create the OVF; line items are prefilled from the quote and PO.'
  }
  return null
}

function poMatchedForRecord(record: SavedQuoteRecord): boolean {
  const form = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  return poMatchLabel(form, record.po) === 'matched'
}
