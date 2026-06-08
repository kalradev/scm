import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { type ScmGrmListTone } from '../lib/scmGrmUtils'
import { listSavedQuotesWithScmPo } from '../lib/savedQuotesStorage'
import { listVendorPoPageRows, type VendorPoDealRow } from '../lib/scmPoDealTotals'

function formatInr(n: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n)
}

function formatIsoDate(iso: string | undefined): string {
  const t = String(iso ?? '').trim()
  if (!t) return '—'
  const ms = Date.parse(t)
  if (Number.isNaN(ms)) return t.slice(0, 10) || t
  return new Date(ms).toLocaleDateString('en-GB')
}

function lastActivityAt(row: VendorPoDealRow): string {
  const t = Math.max(
    Date.parse(String(row.updatedAt || '')) || 0,
    Date.parse(String(row.createdAt || '')) || 0,
  )
  if (!t) return '—'
  return new Date(t).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

function vendorLabel(row: VendorPoDealRow): string {
  if (row.vendorName && row.vendorName !== '—') return row.vendorName
  if (row.vendorDirectoryId) return row.vendorDirectoryId
  return '—'
}

function grmStatusBadgeClass(tone: ScmGrmListTone): string {
  if (tone === 'closed') return 'scm-po__grm-badge scm-po__grm-badge--ok'
  if (tone === 'partial') return 'scm-po__grm-badge scm-po__grm-badge--warn'
  if (tone === 'pending') return 'scm-po__grm-badge scm-po__grm-badge--pending'
  return 'scm-po__grm-badge scm-po__grm-badge--muted'
}

export function ScmVendorsPoPage() {
  const [version, setVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [grmFilter, setGrmFilter] = useState<'all' | 'pending' | 'partial' | 'closed'>('all')

  const rows = useMemo(() => {
    void version
    return listVendorPoPageRows(listSavedQuotesWithScmPo())
  }, [version])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((p) => {
      if (grmFilter !== 'all') {
        if (p.grmFilterKey === 'nolines') return false
        if (p.grmFilterKey !== grmFilter) return false
      }
      if (!q) return true
      const hay = [
        vendorLabel(p),
        p.poRef,
        p.companyPoNumber,
        p.customerName,
        p.quoteRef,
        p.ovfRef,
        p.purchaseDate,
        p.grmLabel,
        formatInr(p.grandInr),
        lastActivityAt(p),
        formatIsoDate(p.createdAt),
        formatIsoDate(p.updatedAt),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [rows, query, grmFilter])

  return (
    <section className="panel scm-home">
      <header className="scm-home__hero">
        <div className="scm-home__hero-text">
          <h2 className="scm-home__title">Vendors &amp; PO</h2>
          <p className="scm-home__desc">
            All saved purchase orders, grouped by vendor, with full PO and company (cache) numbers, deal
            value, and <strong>receipt status (GRN)</strong> — pending, partial, or PO closed. Use search
            to filter.
          </p>
        </div>
        <div className="scm-home__toolbar">
          <label className="scm-po__field" style={{ margin: 0, minWidth: '16rem' }}>
            <span className="scm-po__label">Search</span>
            <input
              type="text"
              className="field__control"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Vendor, PO #, customer, OVF…"
            />
          </label>
          <label className="scm-po__field" style={{ margin: 0, minWidth: '12rem' }}>
            <span className="scm-po__label">Status (GRN)</span>
            <select
              className="field__control"
              value={grmFilter}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'pending' || v === 'partial' || v === 'closed') {
                  setGrmFilter(v)
                } else {
                  setGrmFilter('all')
                }
              }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="partial">Partial</option>
              <option value="closed">PO closed</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-ghost btn--compact"
            onClick={() => setVersion((v) => v + 1)}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="scm-home__block">
        {rows.length === 0 ? (
          <p className="muted scm-home__empty">No saved purchase orders yet.</p>
        ) : filtered.length === 0 ? (
          <p className="muted scm-home__empty">No rows match your filters.</p>
        ) : (
          <div className="scm-home__table-wrap">
            <table className="scm-home__table">
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col">PO ref</th>
                  <th scope="col">Company / cache PO #</th>
                  <th scope="col">Customer</th>
                  <th scope="col" className="scm-vendors-po__num">
                    Deal (INR)
                  </th>
                  <th scope="col">Purchase date</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Receipt (GRN)</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.quoteId}>
                    <td>{vendorLabel(p)}</td>
                    <td className="scm-vendors-po__mono">{p.poRef}</td>
                    <td className="scm-vendors-po__mono">{p.companyPoNumber === '—' ? '—' : p.companyPoNumber}</td>
                    <td>{p.customerName === '—' || !p.customerName ? '—' : p.customerName}</td>
                    <td className="scm-vendors-po__num">{formatInr(p.grandInr)}</td>
                    <td>{p.purchaseDate.trim() || '—'}</td>
                    <td className="scm-vendors-po__nowrap">{lastActivityAt(p)}</td>
                    <td className="scm-po__grm-cell">
                      <span
                        className={grmStatusBadgeClass(p.grmTone)}
                        title="Receipt / delivery (from GRN). Document may still be final in the PO editor."
                      >
                        {p.grmLabel}
                      </span>
                    </td>
                    <td className="scm-home__row-actions">
                      <Link
                        to={`/scm/q/${p.quoteId}/po`}
                        className="btn btn-primary btn--compact"
                      >
                        Edit
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
