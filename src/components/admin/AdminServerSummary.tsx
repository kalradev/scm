import { listScmPoDeliveryAlerts } from '../../lib/scmDeliveryAlerts'

export const ADMIN_DELIVERY_ALERT_DAYS = 7

function AdminKpiIcon({ name }: { name: 'registry' | 'due' }) {
  const p = {
    className: 'admin-dashboard__kpi-icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true as const,
  }
  if (name === 'registry') {
    return (
      <svg {...p}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m0-12.75V3m0 12.75V18m-9-1.5h.008v.008H9.75v-.008z"
        />
      </svg>
    )
  }
  return (
    <svg {...p}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  )
}

export function AdminHeroKpis({
  quotesCount,
  quotesLoading,
  deliveryDueCount,
}: {
  quotesCount: number
  quotesLoading: boolean
  deliveryDueCount: number
}) {
  return (
    <div className="admin-dashboard__kpis" role="region" aria-label="Registry summary">
      <div className="admin-dashboard__kpi">
        <span className="admin-dashboard__kpi-icon" aria-hidden>
          <AdminKpiIcon name="registry" />
        </span>
        <div className="admin-dashboard__kpi-text">
          <span className="admin-dashboard__kpi-value">
            {quotesLoading ? '…' : String(quotesCount)}
          </span>
          <span className="admin-dashboard__kpi-label">Quotes in registry</span>
        </div>
      </div>
      <div className="admin-dashboard__kpi">
        <span className="admin-dashboard__kpi-icon" aria-hidden>
          <AdminKpiIcon name="due" />
        </span>
        <div className="admin-dashboard__kpi-text">
          <span className="admin-dashboard__kpi-value">{deliveryDueCount}</span>
          <span className="admin-dashboard__kpi-label">SCM POs due ≤7d (browser)</span>
        </div>
      </div>
    </div>
  )
}

export function AdminPoDeliveryAlertsPanel() {
  const poDeliveryAlerts = listScmPoDeliveryAlerts(ADMIN_DELIVERY_ALERT_DAYS)
  if (poDeliveryAlerts.length === 0) return null
  return (
    <div className="admin-dashboard__po-alerts" role="region" aria-label="SCM PO delivery">
      <h3 className="admin-dashboard__section-title">
        SCM PO delivery (next {ADMIN_DELIVERY_ALERT_DAYS} days)
      </h3>
      <ul className="admin-dashboard__po-alerts-list">
        {poDeliveryAlerts.map((a) => (
          <li key={`${a.quoteId}-${a.poRef}`}>
            <strong>{a.poRef}</strong> — {a.customerName}, due {a.deliveryDate}
            {a.daysUntil < 0
              ? ' (overdue)'
              : a.daysUntil === 0
                ? ' (today)'
                : ` (${a.daysUntil}d)`}
          </li>
        ))}
      </ul>
      <hr className="admin-dashboard__hr" />
    </div>
  )
}

export function adminRegistryEmptyHint(hasSecret: boolean): string {
  return hasSecret
    ? 'No quotes in the registry yet.'
    : 'Set VITE_SCM_INTERNAL_SECRET to sync the registry.'
}
