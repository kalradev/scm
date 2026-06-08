import type { ExtractedInvoiceLine } from './extractInvoiceLineItems'

export type QuoteInvoiceSeedPayload = {
  lines: ExtractedInvoiceLine[]
  sourceFileName: string
  /** Raw base64 (no data-URL prefix) for the uploaded invoice file, when it fits storage. */
  sourceBase64?: string
  /** MIME type for {@link QuoteInvoiceSeedPayload.sourceBase64}. */
  sourceMimeType?: string
}

/** Session key written before navigating to New quote with `?bootstrap=1`. */
export const QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY = 'scm_quote_invoice_bootstrap_v1'

/**
 * Survives React Strict Mode / URL bootstrap strip: cleared when the finalized quote carries
 * the vendor attachment or Sales starts another invoice import.
 */
export const QUOTE_INVOICE_VENDOR_BRIDGE_KEY = 'scm_quote_invoice_vendor_bridge_v1'

/** Set when a quote is saved for Finance review; Finance home shows a one-time handoff hint. */
export const QUOTE_FINANCE_HANDOFF_REF_KEY = 'scm_finance_quote_handoff_ref_v1'

/** Full message text when SCM finalizes a PO; Finance home shows it once (same pattern as quote handoff). */
export const FINANCE_PO_FINALIZED_NOTICE_KEY = 'scm_finance_po_finalized_notice_v1'

export type QuoteInvoiceVendorBridgePayload = {
  fileName: string
  mimeType: string
  dataBase64: string
}
