/** Row returned by GET /api/admin/quotes (server registry). */
export type QuoteRegistryRow = {
  id: string
  quoteRef: string
  savedAt: string
  savedByOid: string
  savedByEmail: string
  savedByDisplayName: string
  customerName: string
  subject: string
}
