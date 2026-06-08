import {
  getScmPoDefaultBillingAddressForPdf,
  SCM_PO_LETTERHEAD,
} from './scmPoLetterhead'

/**
 * Company ship-from / delivery locations shown on SCM POs.
 * Extend this list as you add real warehouses or branches.
 */

export type CompanyLocation = {
  id: string
  label: string
  address: string
  /** Prefix shown on PO for this branch (drives PO numbering). */
  poPrefix: 'CT' | 'CDT'
  /**
   * Optional per-location registration numbers (for future use / server sync).
   * The PO print preview does not show these; update here when the official numbers are confirmed.
   */
  gstNo?: string
  panNo?: string
  serviceTaxNo?: string
}

export const COMPANY_DELIVERY_LOCATIONS: CompanyLocation[] = [
  {
    id: 'primary-delhi',
    label: 'Cache DigiTech — Kailash Colony (primary)',
    /** Kept in sync with default PO billing/letterhead so dropdown presets match saved POs. */
    address: getScmPoDefaultBillingAddressForPdf(),
    poPrefix: 'CDT',
    gstNo: SCM_PO_LETTERHEAD.gstNo,
    panNo: SCM_PO_LETTERHEAD.panNo,
    serviceTaxNo: SCM_PO_LETTERHEAD.serviceTaxNo,
  },
  {
    id: 'cache-technology',
    label: 'Cache Technology',
    address: ['CACHE TECHNOLOGY', 'CRC 2', 'Sultanpur', '110030', 'India'].join('\n'),
    poPrefix: 'CT',
    // TODO: replace with official Cache Technology registration numbers.
    // Placeholder values (format-valid, but not real registrations).
    gstNo: '09AAACT1111A1Z5',
    panNo: 'FAACT1111F',
    serviceTaxNo: 'FAACT1111FSD001',
  },
]

export const COMPANY_ADDRESS_PRESET_CUSTOM = 'custom' as const

export function getCompanyLocationById(id: string): CompanyLocation | undefined {
  return COMPANY_DELIVERY_LOCATIONS.find((l) => l.id === id)
}
