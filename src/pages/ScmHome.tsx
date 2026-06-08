import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { ScmExportModal } from '../components/ScmExportModal'
import { buildOvfScmOverviewRow } from '../lib/ovfScmSummary'
import { listScmPoDeliveryAlerts } from '../lib/scmDeliveryAlerts'
import {
  listOvfFinanceApprovedForScm,
  listSavedQuotesWithScmPo,
} from '../lib/savedQuotesStorage'

const DELIVERY_ALERT_DAYS = 7

function isOvfPoFinalized(record: { scmPo?: { status: string } | null }): boolean {
  return record.scmPo?.status === 'final'
}

function ScmOvfTable({
  rows,
}: {
  rows: NonNullable<ReturnType<typeof buildOvfScmOverviewRow>>[]
}) {
  return (
    <div className="scm-home__table-wrap">
      <table className="scm-home__table">
        <thead>
          <tr>
            <th scope="col">OVF</th>
            <th scope="col">Customer</th>
            <th scope="col">Approved by</th>
            <th scope="col">Vendor</th>
            <th scope="col">Sell (INR)</th>
            <th scope="col">Purchase (INR)</th>
            <th scope="col">Margin</th>
            <th scope="col">Margin %</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.quoteId}>
              <td>
                <span className={o.ovfRef.trim() ? 'scm-ovf-ref' : undefined}>{o.ovfRef}</span>
              </td>
              <td>{o.customerName}</td>
              <td>{o.approvedBy}</td>
              <td>{o.vendorName}</td>
              <td>{o.sellAmount}</td>
              <td>{o.purchaseAmount}</td>
              <td>{o.marginAmount}</td>
              <td>{o.marginPercent}</td>
              <td className="scm-home__row-actions">
                <Link
                  to={`/scm/q/${o.quoteId}/po`}
                  className="btn btn-primary btn--compact"
                >
                  Create PO
                </Link>
                <Link
                  to={`/scm/q/${o.quoteId}/ovf`}
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
  )
}

function ScmKpiIcon({ name }: { name: 'ovf' | 'po' | 'final' | 'due' }) {
  const p = {
    className: 'scm-home__kpi-icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'ovf':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664M12.75 3h11.25m-11.25 0V9m8.25-6v6M9.75 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21h7.5"
          />
        </svg>
      )
    case 'po':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
          />
        </svg>
      )
    case 'final':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )
    case 'due':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )
    default:
      return null
  }
}

export function ScmHome() {
  const { user } = useAuth()
  const [version] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)

  const approvedRecords = useMemo(() => {
    void version
    return listOvfFinanceApprovedForScm()
  }, [version])

  const handoffRecords = useMemo(
    () => approvedRecords.filter((r) => !isOvfPoFinalized(r)),
    [approvedRecords],
  )

  const poCompleteRecords = useMemo(
    () => approvedRecords.filter((r) => isOvfPoFinalized(r)),
    [approvedRecords],
  )

  const handoffRows = useMemo(
    () =>
      handoffRecords
        .map((r) => buildOvfScmOverviewRow(r))
        .filter(Boolean) as NonNullable<ReturnType<typeof buildOvfScmOverviewRow>>[],
    [handoffRecords],
  )

  const poCompleteRows = useMemo(
    () =>
      poCompleteRecords
        .map((r) => buildOvfScmOverviewRow(r))
        .filter(Boolean) as NonNullable<ReturnType<typeof buildOvfScmOverviewRow>>[],
    [poCompleteRecords],
  )

  const deliveryAlerts = useMemo(() => {
    void version
    return listScmPoDeliveryAlerts(DELIVERY_ALERT_DAYS)
  }, [version])

  const poRows = useMemo(() => {
    void version
    return listSavedQuotesWithScmPo().map((r) => ({ quoteId: r.id }))
  }, [version])

  return (
    <section className="panel scm-home">
      <header className="scm-home__hero">
        <div className="scm-home__hero-text">
          <h2 className="scm-home__title">SCM workspace</h2>
        </div>
      </header>

      <ScmExportModal
        open={exportOpen}
        defaultPreparedBy={(user?.displayName || '').trim()}
        onClose={() => setExportOpen(false)}
      />

      <div className="scm-home__kpis" role="region" aria-label="Workspace summary">
        <div className="scm-home__kpi">
          <span className="scm-home__kpi-icon" aria-hidden>
            <ScmKpiIcon name="ovf" />
          </span>
          <div className="scm-home__kpi-text">
            <span className="scm-home__kpi-value">{handoffRows.length}</span>
            <span className="scm-home__kpi-label">Handoff (PO pending)</span>
          </div>
        </div>
        <div className="scm-home__kpi">
          <span className="scm-home__kpi-icon" aria-hidden>
            <ScmKpiIcon name="final" />
          </span>
          <div className="scm-home__kpi-text">
            <span className="scm-home__kpi-value">{poCompleteRows.length}</span>
          <span className="scm-home__kpi-label">Final POs</span>
          </div>
        </div>
        <div className="scm-home__kpi">
          <span className="scm-home__kpi-icon" aria-hidden>
            <ScmKpiIcon name="po" />
          </span>
          <div className="scm-home__kpi-text">
            <span className="scm-home__kpi-value">{poRows.length}</span>
            <span className="scm-home__kpi-label">Purchase orders</span>
          </div>
        </div>
        <div className="scm-home__kpi">
          <span className="scm-home__kpi-icon" aria-hidden>
            <ScmKpiIcon name="due" />
          </span>
          <div className="scm-home__kpi-text">
            <span className="scm-home__kpi-value">{deliveryAlerts.length}</span>
            <span className="scm-home__kpi-label">Due within {DELIVERY_ALERT_DAYS}d (final)</span>
          </div>
        </div>
      </div>

      {deliveryAlerts.length > 0 ? (
        <div
          className="scm-home__block scm-home__block--alerts"
          role="region"
          aria-label="Delivery reminders"
        >
          <h3 className="scm-home__alerts-title">Delivery within {DELIVERY_ALERT_DAYS} days</h3>
          <ul className="scm-home__alerts-list">
            {deliveryAlerts.map((a) => (
              <li key={`${a.quoteId}-${a.poRef}`}>
                <strong>{a.poRef}</strong> — {a.customerName},{' '}
                <span className="scm-home__alerts-date">due {a.deliveryDate}</span>
                {a.daysUntil < 0 ? (
                  <span className="scm-home__alerts-overdue"> (overdue)</span>
                ) : a.daysUntil === 0 ? (
                  <span className="scm-home__alerts-today"> (today)</span>
                ) : (
                  <span className="scm-home__alerts-soon">
                    {' '}
                    ({a.daysUntil} day{a.daysUntil === 1 ? '' : 's'})
                  </span>
                )}{' '}
                <Link to={`/scm/q/${a.quoteId}/po`} className="scm-home__alerts-link">
                  Edit
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="scm-home__block scm-home__block--handoff">
        <h3 className="scm-home__section-title">Handoff — purchase order</h3>
        <p className="muted scm-home__section-lead">
          Finance approved these OVFs. Create or finish the PO here; once the PO is saved as{' '}
          <strong>Final</strong>, you’ll find it in <strong>Purchase orders</strong> below.
        </p>
        {handoffRows.length === 0 ? (
          <p className="muted scm-home__empty">Nothing in handoff — all caught up, or no finance approvals yet.</p>
        ) : (
          <ScmOvfTable rows={handoffRows} />
        )}
      </div>
    </section>
  )
}
