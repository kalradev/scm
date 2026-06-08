import { tryAcquireGraphAccessToken } from '../auth/acquireGraphToken'
import { registerFinalizedQuoteOnServer } from '../api/quoteRegistryApi'
import type { AuthUser } from '../types/auth'
import type { QuoteRegistryRow } from '../types/quoteRegistry'
import type { SavedQuoteRecord } from './savedQuotesStorage'

function rowFromRecord(
  record: SavedQuoteRecord,
  user: AuthUser,
): QuoteRegistryRow {
  return {
    id: record.id,
    quoteRef: record.quoteRef,
    savedAt: record.savedAt,
    savedByOid: user.oid,
    savedByEmail: user.email,
    savedByDisplayName: user.displayName,
    customerName: record.formSnapshot.customerName?.trim() || '—',
    subject: record.formSnapshot.subject?.trim() || '—',
  }
}

/**
 * Registers a finalized quote on the API so admins can see it company-wide.
 * Uses `VITE_SCM_INTERNAL_SECRET` when set (local dev), otherwise a Graph token.
 */
export async function syncFinalizedQuoteToServer(
  record: SavedQuoteRecord,
  user: AuthUser,
): Promise<void> {
  if (record.kind === 'draft' || !record.quoteRef.trim()) return

  const row = rowFromRecord(record, user)
  const secret = import.meta.env.VITE_SCM_INTERNAL_SECRET?.trim()
  if (secret) {
    await registerFinalizedQuoteOnServer(row)
    return
  }

  const token = await tryAcquireGraphAccessToken()
  if (!token) return

  await registerFinalizedQuoteOnServer(row, token)
}
