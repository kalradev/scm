/**
 * GRN: goods / line-item receipt tracking on a saved PO (per line: pending, partial, delivered).
 * When every tracked line is `delivered`, the PO is considered closed for GRN.
 */
export type ScmGrmLineStatus = 'pending' | 'partial' | 'delivered'

export type ScmGrmState = {
  lineStatusById: Record<string, ScmGrmLineStatus>
  /** Qty received per line (same units as PO line qty). Used for partial receipt (e.g. 2 of 5). */
  quantityReceivedById?: Record<string, string>
  updatedAt: string
}
