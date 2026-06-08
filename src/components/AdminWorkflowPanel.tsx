import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  buildAdminPipelineTableRows,
  computeAdminPipelineSnapshot,
  filterPipelineRowsByDepartment,
  getStageInfo,
  PIPELINE_STAGES,
  pipelineStagesForDepartment,
  type AdminDeptFilter,
  type PipelineStageId,
} from '../lib/adminPipelineMetrics'
import { listAllSavedQuoteRecords } from '../lib/savedQuotesStorage'
import { ROLE_LABELS, roleHomePath } from '../types/roles'
import { useAuth } from '../context/useAuth'

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

type Props = {
  department?: AdminDeptFilter | null
}

const DEPT_ROLES: readonly AdminDeptFilter[] = ['sales', 'finance', 'scm']
const DEPT_COLORS: Record<AdminDeptFilter, string> = {
  sales: '#2563eb',
  finance: '#7c3aed',
  scm: '#059669',
}

function IconKpiDraft() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  )
}

function IconKpiQuotes() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664M12.75 3h11.25m-11.25 0V9m8.25-6v6"
      />
    </svg>
  )
}

function IconKpiMoney() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 18.75a60.07 60.07 0 0015.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75a.75.75 0 01-.75.75H3a.75.75 0 01-.75-.75V5.25zm0 0v-.375c0-.621.504-1.125 1.125-1.125h18.75c.621 0 1.125.504 1.125 1.125V18.75a.75.75 0 01-.75.75H3a.75.75 0 01-.75-.75V15.75"
      />
    </svg>
  )
}

function IconKpiMatch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg className="admin-dash-dept-card__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  )
}

function buildDonutGradient(
  items: Array<{ value: number; color: string }>,
  total: number,
): string {
  if (total <= 0) {
    return 'conic-gradient(from -90deg, rgba(226, 232, 240, 0.95) 0deg 360deg)'
  }
  let cursor = 0
  const segments = items.flatMap((item) => {
    if (item.value <= 0) return []
    const sweep = (item.value / total) * 360
    const start = cursor
    const end = cursor + sweep
    cursor = end
    return [`${item.color} ${start}deg ${end}deg`]
  })
  return `conic-gradient(from -90deg, ${segments.join(', ')})`
}

export function AdminWorkflowPanel({ department = null }: Props) {
  const { user } = useAuth()
  const { snapshot, displayRows } = useMemo(() => {
    const records = listAllSavedQuoteRecords()
    const snap = computeAdminPipelineSnapshot(records)
    const allRows = buildAdminPipelineTableRows(records, 50)
    const tableRows = department
      ? filterPipelineRowsByDepartment(allRows, department)
      : allRows.slice(0, 30)
    return { snapshot: snap, displayRows: tableRows }
  }, [department])

  const itemsHere = department ? (snapshot.pipelineWorkByDept[department] ?? 0) : null
  const totalPipelineItems = DEPT_ROLES.reduce(
    (sum, role) => sum + (snapshot.pipelineWorkByDept[role] ?? 0),
    0,
  )
  const deptChartItems = DEPT_ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    value: snapshot.pipelineWorkByDept[role] ?? 0,
    color: DEPT_COLORS[role],
  }))
  const donutGradient = buildDonutGradient(deptChartItems, totalPipelineItems)
  const stageChartItems = (department
    ? pipelineStagesForDepartment(department)
    : PIPELINE_STAGES
  )
    .map((id) => ({
      id,
      label: getStageInfo(id).short,
      value: snapshot.counts[id] ?? 0,
      owner: getStageInfo(id).owner as AdminDeptFilter,
      color: DEPT_COLORS[getStageInfo(id).owner as AdminDeptFilter],
    }))
    .filter((item) => item.value > 0)
  const maxStageValue = Math.max(1, ...stageChartItems.map((item) => item.value))

  return (
    <div className="admin-dash">
      <header className={`admin-dash__head${department ? ` admin-dash__head--${department}` : ''}`}>
        <div className="admin-dash__head-main">
          <Link
            to={user?.role ? roleHomePath(user.role) : '/awaiting-role'}
            className="link-back admin-dash__back"
            aria-label="Back to workspace"
            title="Back to workspace"
          >
            ←
          </Link>
          <h1 className="admin-dash__page-title">
            {department ? ROLE_LABELS[department] : 'Overview'}
          </h1>
        </div>
      </header>

      {!department ? (
        <div className="admin-dash__kpis" role="region" aria-label="Key metrics">
          <div className="admin-dash__kpi">
            <span className="admin-dash__kpi-icon admin-dash__kpi-icon--sales" aria-hidden>
              <IconKpiDraft />
            </span>
            <div className="admin-dash__kpi-text">
              <span className="admin-dash__kpi-value">{snapshot.counts.sales_quote_draft}</span>
              <span className="admin-dash__kpi-label">Quote drafts</span>
            </div>
          </div>
          <div className="admin-dash__kpi">
            <span className="admin-dash__kpi-icon admin-dash__kpi-icon--neutral" aria-hidden>
              <IconKpiQuotes />
            </span>
            <div className="admin-dash__kpi-text">
              <span className="admin-dash__kpi-value">{snapshot.finalQuotes}</span>
              <span className="admin-dash__kpi-label">Final quotes</span>
            </div>
          </div>
          <div className="admin-dash__kpi">
            <span className="admin-dash__kpi-icon admin-dash__kpi-icon--money" aria-hidden>
              <IconKpiMoney />
            </span>
            <div className="admin-dash__kpi-text">
              <span className="admin-dash__kpi-value">₹{formatInr(snapshot.totalQuotedInr)}</span>
              <span className="admin-dash__kpi-label">Quoted total</span>
            </div>
          </div>
          <div className="admin-dash__kpi">
            <span className="admin-dash__kpi-icon admin-dash__kpi-icon--ok" aria-hidden>
              <IconKpiMatch />
            </span>
            <div className="admin-dash__kpi-text">
              <span className="admin-dash__kpi-value">{snapshot.withPoMatch}</span>
              <span className="admin-dash__kpi-label">PO matched</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="admin-dash__kpis admin-dash__kpis--solo" role="region">
          <div className="admin-dash__kpi admin-dash__kpi--wide">
            <span className={`admin-dash__kpi-icon admin-dash__kpi-icon--${department}`} aria-hidden>
              <IconKpiQuotes />
            </span>
            <div className="admin-dash__kpi-text">
              <span className="admin-dash__kpi-value">{itemsHere}</span>
              <span className="admin-dash__kpi-label">Active items in {ROLE_LABELS[department]}</span>
            </div>
          </div>
        </div>
      )}

      {!department ? (
        <div className="admin-dash__dept-cards" role="navigation" aria-label="Departments">
          {DEPT_ROLES.map((d) => {
            const n = snapshot.pipelineWorkByDept[d] ?? 0
            return (
              <Link key={d} to={`/admin/${d}`} className={`admin-dash-dept-card admin-dash-dept-card--${d}`}>
                <span className="admin-dash-dept-card__label">{ROLE_LABELS[d]}</span>
                <span className="admin-dash-dept-card__value">{n}</span>
                <span className="admin-dash-dept-card__foot">
                  Dashboard
                  <IconChevronRight />
                </span>
              </Link>
            )
          })}
        </div>
      ) : null}

      <section className="admin-dash__charts" aria-label="Visual insights">
        {!department ? (
          <article className="admin-dash-chart-card card-surface">
            <div className="admin-dash-chart-card__head">
              <div>
                <h2 className="admin-dash-chart-card__title">Work split</h2>
                <p className="admin-dash-chart-card__subtle">
                  Current pipeline ownership across departments.
                </p>
              </div>
            </div>
            <div className="admin-dash-donut">
              <div
                className="admin-dash-donut__chart"
                style={{ background: donutGradient }}
                aria-hidden
              >
                <div className="admin-dash-donut__hole">
                  <strong>{totalPipelineItems}</strong>
                  <span>active items</span>
                </div>
              </div>
              <div className="admin-dash-donut__legend" role="list" aria-label="Department split">
                {deptChartItems.map((item) => {
                  const share = totalPipelineItems > 0
                    ? Math.round((item.value / totalPipelineItems) * 100)
                    : 0
                  return (
                    <div key={item.role} className="admin-dash-donut__legend-row" role="listitem">
                      <span
                        className="admin-dash-donut__swatch"
                        style={{ background: item.color }}
                        aria-hidden
                      />
                      <span className="admin-dash-donut__legend-label">{item.label}</span>
                      <span className="admin-dash-donut__legend-value">{item.value}</span>
                      <span className="admin-dash-donut__legend-share">{share}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </article>
        ) : null}

        <article
          className={`admin-dash-chart-card card-surface${department ? ' admin-dash-chart-card--wide' : ''}`}
        >
          <div className="admin-dash-chart-card__head">
            <div>
              <h2 className="admin-dash-chart-card__title">
                {department ? `${ROLE_LABELS[department]} stage load` : 'Stage distribution'}
              </h2>
              <p className="admin-dash-chart-card__subtle">
                {department
                  ? 'Quick stage-by-stage workload view.'
                  : 'Histogram view of quotes across workflow stages.'}
              </p>
            </div>
          </div>
          {stageChartItems.length > 0 ? (
            <div className="admin-dash-bars" role="img" aria-label="Stage distribution chart">
              {stageChartItems.map((item) => (
                <div key={item.id} className="admin-dash-bars__row">
                  <div className="admin-dash-bars__meta">
                    <span className="admin-dash-bars__label">{item.label}</span>
                    <span className="admin-dash-bars__value">{item.value}</span>
                  </div>
                  <div className="admin-dash-bars__track">
                    <span
                      className={`admin-dash-bars__fill admin-dash-bars__fill--${item.owner}`}
                      style={{ width: `${(item.value / maxStageValue) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted admin-dash__empty">No chart data yet.</p>
          )}
        </article>
      </section>

      <section className="admin-dash__block card-surface">
        <h2 className="admin-dash__block-title">
          {department ? `${ROLE_LABELS[department]} stages` : 'Pipeline'}
        </h2>
        {!department ? (
          <div className="admin-dash-pipeline">
            {DEPT_ROLES.map((d) => {
              const stages = pipelineStagesForDepartment(d)
              return (
                <div key={d} className={`admin-dash-pipeline__col admin-dash-pipeline__col--${d}`}>
                  <h3 className="admin-dash-pipeline__head">{ROLE_LABELS[d]}</h3>
                  <ul className="admin-dash-pipeline__list">
                    {stages.map((id) => {
                      const n = snapshot.counts[id] ?? 0
                      return (
                        <li key={id} className="admin-dash-pipeline__row">
                          <span className="admin-dash-pipeline__name">{getStageInfo(id).label}</span>
                          <span className="admin-dash-pipeline__count">{n}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        ) : (
          <ul className="admin-dash-stage-list">
            {pipelineStagesForDepartment(department).map((id: PipelineStageId) => {
              const n = snapshot.counts[id] ?? 0
              return (
                <li key={id} className="admin-dash-stage-list__item">
                  <span className="admin-dash-stage-list__name">{getStageInfo(id).label}</span>
                  <span className="admin-dash-stage-list__badge">{n}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="admin-dash__block card-surface">
        <h2 className="admin-dash__block-title">Activity</h2>
        {displayRows.length === 0 ? (
          <p className="muted admin-dash__empty">No records.</p>
        ) : (
          <div className="admin-dash-table-wrap">
            <table className="admin-dash-table">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Updated</th>
                  <th scope="col" className="admin-dash-table__th-actions" />
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => (
                  <tr key={row.quoteId}>
                    <td>
                      <code className="admin-dash-ref">{row.quoteRef}</code>
                    </td>
                    <td className="admin-dash-table__customer">{row.customer}</td>
                    <td>
                      <span className="admin-dash-stage-pill">{getStageInfo(row.stageId).label}</span>
                    </td>
                    <td className="admin-dash-table__muted">{row.activityLabel}</td>
                    <td className="admin-dash-table__actions">
                      {row.link ? (
                        <Link to={row.link.to} className="btn btn-primary btn--compact">
                          {row.link.label}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
