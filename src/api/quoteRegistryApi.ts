import type { QuoteRegistryRow } from '../types/quoteRegistry'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function internalHeaders(): Record<string, string> {
  const secret = import.meta.env.VITE_SCM_INTERNAL_SECRET?.trim()
  if (!secret) return {}
  return { 'X-SCM-Internal-Secret': secret }
}

export async function registerFinalizedQuoteOnServer(
  row: QuoteRegistryRow,
  accessToken?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...internalHeaders(),
  }
  if (!headers['X-SCM-Internal-Secret'] && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }
  if (!headers['X-SCM-Internal-Secret'] && !headers.Authorization) {
    return
  }

  const res = await fetch(`${API_BASE}/api/quotes/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const t = await res.text()
    console.warn('[quotes/register]', res.status, t)
  }
}

export async function fetchAdminQuoteRegistry(
  accessToken?: string,
): Promise<QuoteRegistryRow[]> {
  const headers: Record<string, string> = { ...internalHeaders() }
  if (!headers['X-SCM-Internal-Secret']) {
    if (!accessToken) throw new Error('no_auth')
    headers.Authorization = `Bearer ${accessToken}`
  }

  const res = await fetch(`${API_BASE}/api/admin/quotes`, { headers })
  if (!res.ok) throw new Error('fetch_quotes_failed')
  const data = (await res.json()) as { quotes: QuoteRegistryRow[] }
  return data.quotes ?? []
}
