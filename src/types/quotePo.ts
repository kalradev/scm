/** Customer PO attached to a finalized quote (stored client-side). */
export type QuotePoState = {
  fileName: string
  mimeType: string
  /** Data URL or raw base64 payload for re-download */
  dataBase64: string
  uploadedAt: string
  /** INR total as entered from the PO (compare to quote grand total). */
  poTotalInr: string
  /** Parsed from PDF/Excel text on upload; editable on the PO page. */
  customerPoNumber?: string
  /**
   * When the PO total was last compared against the quote total.
   * Used to flag cases where quote lines were edited after a PO was matched.
   */
  comparedAt?: string
  /** Quote grand total (INR) at the time of compare. */
  quoteTotalInrAtCompare?: number
  /** Non-blocking flag: quote changed after PO compare. */
  quoteChangedAfterCompareAt?: string
}
