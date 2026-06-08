import type { OvfProofAttachment } from './ovf'

/** Finance reviews the finalized quote vs vendor invoice before Customer PO. */
export type QuoteFinanceReviewStatus =
  | 'pending_finance'
  | 'finance_approved'
  | 'finance_rejected'

export type QuoteFinanceReviewState = {
  workflowStatus: QuoteFinanceReviewStatus
  vendorInvoice?: OvfProofAttachment
  submittedToFinanceAt?: string
  financeDecisionAt?: string
  financeApprovedBy?: string
  financeApprovedByOid?: string
  financeRejectionNote?: string
  /** Net vendor payable when parsed from invoice footer (balance due, or line sum − deposit). */
  vendorNetPurchaseInr?: number
  /** Deposit / advance shown on supplier invoice (informational). */
  vendorDepositInr?: number
}

/** Sales confirms the quotation was sent externally to the buyer. */
export type CustomerQuoteShipmentState = {
  sentToCustomerAt?: string
}

/** Finance verifies customer PO (GST etc.) before OVF is allowed. */
export type PoFinanceReviewStatus =
  | 'pending_finance'
  | 'finance_approved'
  | 'finance_rejected'

export type PoFinanceReviewState = {
  workflowStatus: PoFinanceReviewStatus
  submittedToFinanceAt?: string
  financeDecisionAt?: string
  financeApprovedBy?: string
  financeApprovedByOid?: string
  financeRejectionNote?: string
}
