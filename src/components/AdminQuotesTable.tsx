import type { QuoteRegistryRow } from '../types/quoteRegistry'

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

type Props = {
  quotes: QuoteRegistryRow[]
  loading: boolean
  error: string | null
  emptyHint?: string
}

export function AdminQuotesTable({ quotes, loading, error, emptyHint }: Props) {
  return (
    <div className="admin-quotes">
      <h3 className="admin-quotes__title">Quotes (Sales)</h3>
      {error ? (
        <p className="admin-dashboard__error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="muted">Loading quotes…</p>
      ) : quotes.length === 0 ? (
        <p className="muted">{emptyHint ?? 'No quotes registered yet.'}</p>
      ) : (
        <div className="sales-dashboard__table-wrap">
          <table className="sales-dashboard__table admin-quotes__table">
            <thead>
              <tr>
                <th>Quote no.</th>
                <th>Created</th>
                <th>Sales user</th>
                <th>Email</th>
                <th>Customer</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td>
                    <strong>{q.quoteRef}</strong>
                  </td>
                  <td>{formatWhen(q.savedAt)}</td>
                  <td>{q.savedByDisplayName}</td>
                  <td className="admin-quotes__cell-muted">{q.savedByEmail}</td>
                  <td>{q.customerName}</td>
                  <td>{q.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
