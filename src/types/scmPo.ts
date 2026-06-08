import type { ScmPoGlobalTermsItem } from '../lib/scmPoTermsStorage'

/** SCM-authored purchase order attached to a finance-approved OVF (same quote record). */
export type ScmPoWorkflowStatus = 'draft' | 'final'

export type ScmPoLine = {
  id: string
  /** Full specification / long text for the line. */
  itemDetails: string
  partNumber: string
  /** HSN / SAC for GST line reporting (optional). */
  hsnCode: string
  /** Goods, Services, Asset, Other, or a custom label. */
  poType: string
  quantity: string
  /** Unit rate (INR) before tax. */
  rate: string
  /** Distribution charges percent applied on line subtotal (qty × rate). */
  distributionPct?: string
  /** Tax percent applied on (qty × rate), e.g. 18 for 18% GST. */
  tax: string
  /** @deprecated Loaded from storage only; use `itemDetails`. */
  description?: string
}

export type ScmPoPaymentPreset = '15' | '30' | '45' | '60' | 'custom'

export type ScmPoDistributionChargeMode = 'pct' | 'inr'

export type ScmPoStoredState = {
  poRef: string
  status: ScmPoWorkflowStatus
  /** SCM user who created / last updated this PO (for ref sequence + audit). */
  scmSavedByOid: string
  scmSavedByDisplayName?: string
  createdAt?: string
  updatedAt?: string
  vendorDirectoryId: string
  vendorAddressId: string
  /** Denormalized for exports if directory rows change. */
  vendorNameSnapshot: string
  vendorAddressSnapshot: string
  sourceOfSupply: string
  destinationOfSupply: string
  companyLocationId: string
  /**
   * Billing address block on the PO PDF/preview (editable). Defaults to registered office.
   */
  poBillingAddress: string
  /**
   * Company header address next to the logo (editable). Separate from billing/shipping blocks.
   */
  poCompanyAddress: string
  /**
   * Shipping address block on the PO PDF/preview (editable). Defaults from company location / OVF.
   */
  poShippingAddress: string
  purchaseDate: string
  deliveryDate: string
  paymentTermsDays: number
  paymentTermsPreset: ScmPoPaymentPreset | ''
  /**
   * @deprecated Legacy global distribution charges. Distribution is now entered per-line
   * as `line.distributionPct` (percent of line subtotal).
   */
  distributionChargesMode?: ScmPoDistributionChargeMode
  /**
   * @deprecated Legacy global distribution charges value. Distribution is now entered per-line.
   */
  distributionChargesValue?: string
  ovfNumber: string
  quoteNumber: string
  /** Internal company PO from OVF (e.g. PO/25-26/001); shown on SCM PO screen and export. */
  companyPoNumber: string
  customerPoNumber: string
  customerPoDate: string
  ovfApprover: string
  customerName: string
  customerGstin: string
  /** Terms & conditions printed on a separate page in the PO PDF/preview. */
  termsAndConditions: string
  /**
   * Full list of terms rows (incl. unfixed for editing). `termsAndConditions` is the fixed-only text.
   */
  termsLineItems?: ScmPoGlobalTermsItem[]
  /**
   * If true, SCM is using the global fixed terms for every PO (editable only in settings).
   * Stored on the PO so old drafts stay stable even if the global setting changes.
   */
  termsUseGlobal: boolean
  lines: ScmPoLine[]
}
