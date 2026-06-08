export type SenderAddressPreset = 'primary' | 'secondary'

export type QuoteLineForm = {
  id: string
  /** Short product / SKU name (PDF “Product” column). */
  product: string
  /** Longer specification text (PDF “Description” column). */
  description: string
  qty: string
  /** Unit price shown on this **customer** quote / PDF — always entered here, never auto-filled from the supplier invoice. */
  unitPrice: string
  /** Supplier invoice unit rate when parsed from import — for Finance/OVF margin only, not displayed as quote unit price. */
  vendorUnitPrice?: string
  /** When set, product / description / qty came from invoice import and stay read-only. */
  invoiceImported?: boolean
}

export type QuoteFormData = {
  /** Letterhead + footer: Cache Digitech vs placeholder xyz. */
  senderAddressPreset: SenderAddressPreset
  quoteRef: string
  quoteDate: string
  validUntil: string
  customerName: string
  /**
   * Line after recipient on the PDF. Use the buyer company exactly as on the PO when the PO prints one (authoritative). If the PO shows no distinct company/legal buyer, informal text here is acceptable (often matches how the deal is referenced).
   */
  customerCompanyName: string
  /** Street/city lines in the quote PDF recipient block (one line per row). */
  customerAddress: string
  /** Letter-style subject after “To,” (PDF: bold `Sub: …`). */
  subject: string
  /** Salutation line (e.g. “Dear Sir,”). */
  quoteSalutation: string
  /** Intro paragraphs before the commercials table; use a blank line between paragraphs. */
  quoteIntro: string
  /** Closing paragraph after the table (before terms). */
  quoteClosing: string
  /** Shown on the final PDF page after line items (numbered list, one line per row). */
  termsAndConditions: string
  /** Printed after “Thank you,” on the final terms page. */
  signatoryName: string
  lineItems: QuoteLineForm[]
}
