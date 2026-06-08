/** Optional file Sales attaches as evidence for Finance / SCM (stored on the quote OVF). */
export type OvfProofAttachment = {
  id: string
  fileName: string
  mimeType: string
  dataBase64: string
  uploadedAt: string
}

/** How freight / finance amounts apply to the customer line subtotal. */
export type OvfMoneyUnit = 'inr' | 'percent'

/** Lifecycle: sales owns edits until submitted; finance approves or rejects; SCM sees approved only. */
export type OvfWorkflowStatus =
  | 'sales_draft'
  | 'pending_finance'
  | 'finance_rejected'
  | 'finance_approved'

/** Editable OVF fields (stored on the finalized quote record). */
export type OvfFormFields = {
  creationDate: string
  customerName: string
  /** Customer GSTIN (for downstream SCM PO). */
  customerGstin: string
  /** Summary / primary product line (often one line; editable). */
  productName: string
  billingAddress: string
  quoteNumber: string
  billingState: string
  contactPerson: string
  contactNumber: string
  contactEmail: string
  vendorPoNumber: string
  vendorContactNumber: string
  vendorEmailId: string
  /** Quote signatory (person who signed the quote PDF); prefilled from the quote. */
  ovfModuleOwner: string
  /** When set, vendor row comes from the directory (see `vendorAddressId`). */
  vendorDirectoryId: string
  vendorAddressId: string
  /** Multi-line vendor location for OVF / exports (from directory or typed in custom mode). */
  vendorAddressDetail: string
  vendorName: string
  margin: string
  marginPercent: string
  country: string
  /** Customer’s PO reference (same role as former “PO number” field). */
  customerPoNumber: string
  /**
   * Internal company purchase order ref (e.g. `PO/25-26/001`). Assigned when
   * Sales submits to Finance; SCM may correct it.
   */
  companyPoNumber: string
  shippingAddress: string
  shippingState: string
  deliveryPeriod: string
  installationServiceDetails: string
  customerPaymentTerms: string
  vendorPaymentTerms: string
  freightCharges: string
  /** Whether `freightCharges` is a fixed INR amount or a % of line sell subtotal. */
  freightChargesUnit: OvfMoneyUnit
  financeCost: string
  financeCostUnit: OvfMoneyUnit
  additionalCharges: string
  /** Applied to compute GST columns on customer charges (percent). */
  gstPercent: string
  /**
   * Per quote line id: vendor purchase unit price (same basis as quote unit price).
   * Used to compute purchase total, margin, and margin % automatically.
   */
  vendorPurchaseUnitByLineId: Record<string, string>
}

export type OvfStoredState = {
  ovfRef: string
  fields: OvfFormFields
  /** Sales-only uploads; visible to Finance and SCM on this OVF. */
  proofAttachments?: OvfProofAttachment[]
  updatedAt?: string
  workflowStatus?: OvfWorkflowStatus
  /** When sales submitted this OVF for finance review (ISO). */
  submittedToFinanceAt?: string
  /** Optional; legacy mail-to recipient (no longer required for workflow). */
  lastFinanceEmailTo?: string
  financeApprovedBy?: string
  financeApprovedByOid?: string
  financeDecisionAt?: string
  financeRejectionNote?: string
  /** @deprecated Legacy share UI; ignored for workflow. */
  financeEmailDraft?: string
  emailSharePending?: boolean
  emailSharePendingSavedAt?: string
}
