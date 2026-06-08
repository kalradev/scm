/**
 * Buyer (Cache) block on the SCM PO — fixed registered office next to the logo.
 * The editable header next to the logo is `poCompanyAddress` (separate from billing/shipping).
 * Billing / shipping in the lower quad are edited on the PO (`poBillingAddress` / `poShippingAddress`).
 */
export const SCM_PO_LETTERHEAD = {
  legalName: 'CACHE DIGITECH PVT LTD',
  /** Fixed lines under the company name (registered office). */
  registeredAddressLines: [
    'L-31 Ground Floor, Kailash Colony,',
    'New Delhi,',
    'Delhi-110048,',
    'India',
  ] as const,
  /** Single-line summary (exports, fallbacks). */
  addressLine:
    'L-31 Ground Floor, Kailash Colony, New Delhi, Delhi-110048, India',
  phone: 'Tel: 011-47105700-25',
  gstNo: '07AAACC4248H1ZU',
  panNo: 'AAACC4248H',
  serviceTaxNo: 'AAACC4248HSD001',
} as const

/** Default “Billing address” quad text: company name + registered lines (no phone). */
export function getScmPoDefaultBillingAddressForPdf(): string {
  return [SCM_PO_LETTERHEAD.legalName, ...SCM_PO_LETTERHEAD.registeredAddressLines].join(
    '\n',
  )
}
