import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { formatQuoteDateDisplay } from '../lib/senderAddresses'
import {
  deleteDraftForUser,
  isQuoteDraft,
  listSavedQuotesForUser,
  SAVED_QUOTES_LOCAL_STORAGE_KEY,
  SAVED_QUOTES_UPDATED_EVENT,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import type { QuoteFormData } from '../types/quotePdf'

const DELETE_DRAFT_CONFIRM =
  'Delete this draft permanently?\n\nThis cannot be undone. Other drafts and finalized quotes are not affected.'

export function SalesDraftsPage() {
  const { user } = useAuth()
  const [listVersion, setListVersion] = useState(0)

  const drafts = useMemo(() => {
    if (!user) return []
    return listSavedQuotesForUser(user.oid)
      .filter(isQuoteDraft)
      .sort(
        (a, b) =>
          new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
      )
  }, [user, listVersion])

  const refreshList = useCallback(() => setListVersion((v) => v + 1), [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_QUOTES_LOCAL_STORAGE_KEY) refreshList()
    }
    const onUpdated = () => refreshList()
    window.addEventListener('storage', onStorage)
    window.addEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    }
  }, [refreshList])

  const handleDeleteDraft = useCallback(
    (row: SavedQuoteRecord) => {
      if (!user || !isQuoteDraft(row)) return
      if (!window.confirm(DELETE_DRAFT_CONFIRM)) return
      if (deleteDraftForUser(row.id, user.oid)) refreshList()
    },
    [user, refreshList],
  )

  return (
    <section className="panel sales-dashboard sales-drafts-page">
      <header className="sales-dashboard__hero">
        <div className="sales-dashboard__hero-text">
          <h2 className="sales-dashboard__title">Draft quotes</h2>
          <p className="sales-dashboard__tagline muted">
            Work in progress — continue editing or delete. Finalized quotes appear
            under Quotes &amp; OVF.
          </p>
        </div>
        <div className="sales-dashboard__hero-actions">
          <Link to="/sales/quote/from-invoice" className="btn btn-primary">
            New from invoice
          </Link>
        </div>
      </header>

      {drafts.length === 0 ? (
        <div className="sales-drafts-page__empty">
          <p className="muted">No draft quotes saved yet.</p>
          <Link to="/sales/quote/from-invoice" className="btn btn-primary">
            Upload invoice
          </Link>
        </div>
      ) : (
        <div className="sales-dashboard__table-wrap">
          <table className="sales-dashboard__table sales-drafts-page__table">
            <thead>
              <tr>
                <th scope="col">Draft</th>
                <th scope="col">Recipient</th>
                <th scope="col">Quote date</th>
                <th scope="col" className="sales-dashboard__table-col--status">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((row) => {
                const form = normalizeQuoteFormData(
                  row.formSnapshot as QuoteFormData & { customerTitle?: string },
                )
                return (
                  <tr key={row.id} className="sales-drafts-page__row">
                    <td>
                      <span className="sales-dashboard__draft-no-label">Draft</span>
                    </td>
                    <td>{form.customerName.trim() || '—'}</td>
                    <td>{formatQuoteDateDisplay(row.formSnapshot.quoteDate)}</td>
                    <td>
                      <div className="sales-dashboard__row-actions">
                        <Link
                          to={`/sales/quote/new?draft=${row.id}`}
                          className="btn btn-ghost btn--compact"
                        >
                          Continue
                        </Link>
                        <button
                          type="button"
                          className="btn btn-ghost btn--compact sales-dashboard__delete-draft"
                          onClick={() => handleDeleteDraft(row)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
