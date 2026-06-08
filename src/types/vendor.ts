/** One physical / billing location for a vendor. */
export type VendorAddress = {
  id: string
  /** Legacy / internal; UI uses address lines only. */
  label: string
  /** Multi-line postal address. */
  lines: string
}

/** Vendor master row (owned by a sales user in local storage). */
export type VendorEntry = {
  id: string
  name: string
  addresses: VendorAddress[]
  updatedAt: string
}
