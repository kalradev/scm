import type { SavedQuoteRecord } from '../lib/savedQuotesStorage'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

export type WorkflowQuotesStatus = {
  enabled: boolean
}

export async function fetchWorkflowQuotesStatus(): Promise<WorkflowQuotesStatus> {
  const res = await fetch(`${API_BASE}/api/workflow/quotes/status`)
  if (!res.ok) return { enabled: false }
  return res.json() as Promise<WorkflowQuotesStatus>
}

export async function fetchWorkflowQuotesFromServer(
  token: string,
): Promise<SavedQuoteRecord[]> {
  const res = await fetch(`${API_BASE}/api/workflow/quotes`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error('workflow_quotes_fetch_failed')
  }
  const data = (await res.json()) as { quotes?: SavedQuoteRecord[] }
  return Array.isArray(data.quotes) ? data.quotes : []
}

export async function syncWorkflowQuotesToServer(
  token: string,
  quotes: SavedQuoteRecord[],
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/workflow/quotes/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ quotes }),
  })
  if (!res.ok) {
    throw new Error('workflow_quotes_sync_failed')
  }
}

export async function deleteWorkflowQuoteOnServer(
  token: string,
  id: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/workflow/quotes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error('workflow_quotes_delete_failed')
  }
}
