import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ScmGrmModal } from '../components/ScmGrmModal'
import { getScmGrmListLabel, type ScmGrmListTone } from '../lib/scmGrmUtils'
import { listSavedQuotesWithScmPo } from '../lib/savedQuotesStorage'

function formatCreatedDate(iso: string | undefined): string {
  const t = String(iso ?? '').trim()
  if (!t) return '—'
  const ms = Date.parse(t)
  if (Number.isNaN(ms)) return t.slice(0, 10) || t
  return new Date(ms).toLocaleDateString('en-GB')
}

function formatDeliveryColumn(raw: string | undefined): string {
  const t = String(raw ?? '').trim()
  if (!t || t === '—') return 'not set'
  return t
}

function receiptStatusBadgeClass(tone: ScmGrmListTone): string {
  if (tone === 'closed') return 'scm-po__grm-badge scm-po__grm-badge--ok'
  if (tone === 'partial') return 'scm-po__grm-badge scm-po__grm-badge--warn'
  if (tone === 'pending') return 'scm-po__grm-badge scm-po__grm-badge--pending'
  return 'scm-po__grm-badge scm-po__grm-badge--muted'
}

export function ScmPurchaseOrdersPage() {
  const { pathname } = useLocation()
  const [listVersion, setListVersion] = useState(0)
  const [grmModalQuoteId, setGrmModalQuoteId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [receiptStatusFilter, setReceiptStatusFilter] = useState<
    'all' | 'pending' | 'partial' | 'closed'
  >('all')
  const poRows = useMemo(() => {
    return listSavedQuotesWithScmPo().map((r) => {
      const receipt = getScmGrmListLabel(r.scmPo!.lines, r.scmGrm)
      return {
        quoteId: r.id,
        poRef: r.scmPo!.poRef || '—',
        customerName: (r.scmPo!.customerName || '').trim() || '—',
        deliveryDate: formatDeliveryColumn(r.scmPo!.deliveryDate),
        ovfRef: r.ovf?.ovfRef ?? '—',
        createdAt: r.scmPo!.createdAt,
        ovfCreatedBy:
          (r.ovf?.fields?.ovfModuleOwner || '').trim() ||
          (r.savedByDisplayName || '').trim() ||
          '—',
        ovfApprovedBy: (r.ovf?.financeApprovedBy || '').trim() || '—',
        receiptLabel: receipt.label,
        receiptTone: receipt.tone,
        receiptFilterKey: receipt.filterKey,
      }
    })
  }, [pathname, listVersion])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return poRows.filter((p) => {
      if (receiptStatusFilter !== 'all') {
        if (p.receiptFilterKey === 'nolines') return false
        if (p.receiptFilterKey !== receiptStatusFilter) return false
      }
      if (!q) return true
      const hay =
        `${p.poRef} ${p.ovfRef} ${p.customerName} ${p.deliveryDate} ${p.receiptLabel} ${formatCreatedDate(p.createdAt)} ${p.ovfCreatedBy} ${p.ovfApprovedBy}`.toLowerCase()
      return hay.includes(q)
    })
  }, [poRows, query, receiptStatusFilter])

  return (
    <section className="panel scm-home">
      {grmModalQuoteId ? (
        <ScmGrmModal
          quoteId={grmModalQuoteId}
          onClose={() => setGrmModalQuoteId(null)}
          onSaved={() => setListVersion((v) => v + 1)}
        />
      ) : null}
      <header className="scm-home__hero">
        <div className="scm-home__hero-text">
          <h2 className="scm-home__title">Purchase orders</h2>
        </div>
        <div className="scm-home__toolbar">
          <label className="scm-po__field" style={{ margin: 0, minWidth: '16rem' }}>
            <span className="scm-po__label">Search</span>
            <input
              type="text"
              className="field__control"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="PO / OVF / customer…"
            />
          </label>
          <label className="scm-po__field" style={{ margin: 0, minWidth: '12rem' }}>
            <span className="scm-po__label">Status (GRN)</span>
            <select
              className="field__control"
              value={receiptStatusFilter}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'pending' || v === 'partial' || v === 'closed') {
                  setReceiptStatusFilter(v)
                } else {
                  setReceiptStatusFilter('all')
                }
              }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="partial">Partial</option>
              <option value="closed">PO closed</option>
            </select>
          </label>
        </div>
      </header>

      <div className="scm-home__block">
        {poRows.length === 0 ? (
          <p className="muted scm-home__empty">No POs yet.</p>
        ) : filtered.length === 0 ? (
          <p className="muted scm-home__empty">No matches.</p>
        ) : (
          <div className="scm-home__table-wrap">
            <table className="scm-home__table">
              <thead>
                <tr>
                  <th scope="col">PO</th>
                  <th scope="col">OVF</th>
                  <th scope="col">Customer</th>
                  <th scope="col">OVF created by</th>
                  <th scope="col">OVF approved by</th>
                  <th scope="col">Created (SCM)</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.quoteId}>
                    <td>{p.poRef}</td>
                    <td>
                      <span className={p.ovfRef !== '—' ? 'scm-ovf-ref' : undefined}>{p.ovfRef}</span>
                    </td>
                    <td>{p.customerName}</td>
                    <td>{p.ovfCreatedBy}</td>
                    <td>{p.ovfApprovedBy}</td>
                    <td>{formatCreatedDate(p.createdAt)}</td>
                    <td className="scm-po__grm-cell">
                      <span
                        className={receiptStatusBadgeClass(p.receiptTone)}
                        title="Receipt / delivery (from GRN)"
                      >
                        {p.receiptLabel}
                      </span>
                    </td>
                    <td className="scm-home__row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn--compact"
                        title="Goods receipt — line delivery (GRN)"
                        onClick={() => setGrmModalQuoteId(p.quoteId)}
                      >
                        GRN
                      </button>
                      <Link
                        to={`/scm/q/${p.quoteId}/ovf`}
                        className="btn btn-ghost btn--compact"
                      >
                        View OVF
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

