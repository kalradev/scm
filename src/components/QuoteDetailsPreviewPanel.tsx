import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { filterCommercialLines } from '../lib/quoteLineItems'
import { quoteGrandTotalInr } from '../lib/quotePoMatch'
import { lineAmount } from '../lib/quotePdfTemplate'
import {
  getSavedQuoteByIdForUser,
  isQuoteDraft,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import { formatQuoteDateDisplay } from '../lib/senderAddresses'
import type { QuoteFormData } from '../types/quotePdf'

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

type Props = {
  quoteId: string
  onClose?: () => void
}

export function QuoteDetailsPreviewPanel({ quoteId, onClose }: Props) {
  const { user } = useAuth()
  const [record, setRecord] = useState<SavedQuoteRecord | null | undefined>(
    undefined,
  )

  const reload = useCallback(() => {
    if (!user || !quoteId) {
      setRecord(null)
      return
    }
    setRecord(getSavedQuoteByIdForUser(quoteId, user.oid) ?? null)
  }, [user, quoteId])

  useEffect(() => {
    reload()
  }, [reload])

  const data = useMemo(() => {
    if (!record) return null
    return normalizeQuoteFormData(
      record.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
  }, [record])

  const lines = useMemo(
    () => (data ? filterCommercialLines(data.lineItems) : []),
    [data],
  )

  const quoteTotal = data ? quoteGrandTotalInr(data) : 0

  if (!user) {
    return (
      <div className="quote-details-preview__fallback">
        <p className="muted">You need to be signed in.</p>
        {onClose ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    )
  }

  if (record === undefined) {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  if (!record || isQuoteDraft(record)) {
    return (
      <div className="quote-details-preview__fallback">
        <p className="muted">This quote is not available.</p>
        {onClose ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <section className="quote-details-preview">
      <h2 className="quote-details-preview__title">Quote {record.quoteRef}</h2>

      <div className="quote-details-preview__summary">
        <div>
          <span className="quote-details-preview__label">Quote grand total (INR)</span>
          <strong className="quote-details-preview__amount">
            {formatInr(quoteTotal)}
          </strong>
        </div>
        <div>
          <span className="quote-details-preview__label">Recipient</span>
          <span>{data?.customerName.trim() || '—'}</span>
        </div>
        <div>
          <span className="quote-details-preview__label">Quote date</span>
          <span>{data ? formatQuoteDateDisplay(data.quoteDate) : '—'}</span>
        </div>
        <div>
          <span className="quote-details-preview__label">Valid until</span>
          <span>{data ? formatQuoteDateDisplay(data.validUntil) : '—'}</span>
        </div>
      </div>

      {data?.customerCompanyName.trim() ? (
        <div className="quote-details-preview__block">
          <span className="quote-details-preview__label">Company</span>
          <p className="quote-details-preview__text">{data.customerCompanyName.trim()}</p>
        </div>
      ) : null}

      {data?.subject.trim() ? (
        <div className="quote-details-preview__block">
          <span className="quote-details-preview__label">Subject</span>
          <p className="quote-details-preview__text">{data.subject.trim()}</p>
        </div>
      ) : null}

      {data?.customerAddress.trim() ? (
        <div className="quote-details-preview__block">
          <span className="quote-details-preview__label">Address</span>
          <p className="quote-details-preview__text quote-details-preview__address">
            {data.customerAddress.trim()}
          </p>
        </div>
      ) : null}

      <h3 className="quote-details-preview__section-title">Line items</h3>
      {lines.length === 0 ? (
        <p className="muted">No commercial lines on this quote.</p>
      ) : (
        <div className="quote-details-preview__table-wrap">
          <table className="quote-details-preview__table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Description</th>
                <th scope="col" className="quote-details-preview__num">
                  Qty
                </th>
                <th scope="col" className="quote-details-preview__num">
                  Unit (INR)
                </th>
                <th scope="col" className="quote-details-preview__num">
                  Line total
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => {
                const amt = lineAmount(ln)
                return (
                  <tr key={ln.id}>
                    <td>{(ln.product || '').trim() || '—'}</td>
                    <td>{(ln.description || '').trim() || '—'}</td>
                    <td className="quote-details-preview__num">{ln.qty || '—'}</td>
                    <td className="quote-details-preview__num">
                      {String(ln.unitPrice ?? '').trim()
                        ? formatInr(
                            Number.parseFloat(
                              String(ln.unitPrice).replace(/,/g, ''),
                            ) || 0,
                          )
                        : '—'}
                    </td>
                    <td className="quote-details-preview__num">{formatInr(amt)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="quote-details-preview__foot-label">
                  Grand total
                </td>
                <td className="quote-details-preview__num quote-details-preview__foot-total">
                  {formatInr(quoteTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="muted quote-details-preview__hint">
        To upload a PO or match totals, use{' '}
        <strong>Upload PO</strong> or <strong>PO</strong> in the quotes list, or{' '}
        <Link to={`/sales/q/${quoteId}`} className="link-back" onClick={onClose}>
          open quote &amp; PO
        </Link>
        .
      </p>
    </section>
  )
}
