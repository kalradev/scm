import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

const SIDEBAR_COLLAPSED_KEY = 'scm_sales_sidebar_collapsed'

function linkClass(isActive: boolean): string {
  return `sales-dash__nav-link${isActive ? ' sales-dash__nav-link--active' : ''}`
}

function userInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0]?.[0] ?? '?').toUpperCase()
}

function IconOverview() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m0-12.75V3m0 12.75V18m-9-1.5h.008v.008H9.75v-.008zm0-3.75h.008v.008H9.75V9zm0-3.75h.008v.008H9.75v-.008z"
      />
    </svg>
  )
}

function IconNewQuote() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  )
}

function IconUserSwitch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632zM18 9.75l2.25 2.25m0 0l2.25 2.25M20.25 12l2.25-2.25M20.25 12l-2.25-2.25"
      />
    </svg>
  )
}

function IconChevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      {direction === 'left' ? (
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      )}
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  )
}

export function SalesDashboardLayout() {
  const { pathname } = useLocation()
  const { user, switchAccount, mode } = useAuth()
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  })

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c)
  }, [])

  const overviewActive =
    pathname === '/sales' || pathname.startsWith('/sales/q/')

  const initials = user?.displayName ? userInitials(user.displayName) : '?'
  const switchLabel = mode === 'azure' ? 'Switch account' : 'Switch user'

  return (
    <div className="sales-dash">
      <aside
        className={`sales-dash__sidebar${collapsed ? ' sales-dash__sidebar--collapsed' : ''}`}
        aria-label="Sales workspace"
      >
        <div className="sales-dash__sidebar-top">
          <button
            type="button"
            className="sales-dash__sidebar-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="sales-dash-nav"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <span className="sales-dash__sidebar-toggle-icon" aria-hidden>
              <IconChevron direction={collapsed ? 'right' : 'left'} />
            </span>
          </button>
          <p
            id="sales-dash-workspace-label"
            className={`sales-dash__sidebar-heading${collapsed ? ' sales-dash__sidebar-heading--vh' : ''}`}
          >
            Workspace
          </p>
        </div>

        <nav
          id="sales-dash-nav"
          className="sales-dash__nav"
          aria-labelledby="sales-dash-workspace-label"
        >
          <Link
            to="/sales"
            className={linkClass(overviewActive)}
            aria-current={overviewActive ? 'page' : undefined}
            title="Quotes & OVF"
            aria-label={collapsed ? 'Quotes & OVF' : undefined}
          >
            <span className="sales-dash__nav-icon">
              <IconOverview />
            </span>
            <span className="sales-dash__nav-text">Quotes &amp; OVF</span>
          </Link>
          <NavLink
            to="/sales/quote/from-invoice"
            className={({ isActive }) => linkClass(isActive)}
            title="Upload invoice to start a quote"
            aria-label={collapsed ? 'From invoice' : undefined}
          >
            <span className="sales-dash__nav-icon">
              <IconNewQuote />
            </span>
            <span className="sales-dash__nav-text">From invoice</span>
          </NavLink>
        </nav>

        <div className="sales-dash__sidebar-spacer" aria-hidden />

        <div className="sales-dash__sidebar-bottom">
          <button
            type="button"
            className="sales-dash__user-switch"
            title={switchLabel}
            aria-label={switchLabel}
            onClick={() => void switchAccount()}
          >
            {!collapsed ? (
              <>
                <span className="sales-dash__user-avatar" aria-hidden>
                  {initials}
                </span>
                <span className="sales-dash__user-text">
                  <span className="sales-dash__user-name">
                    {user?.displayName ?? '—'}
                  </span>
                  <span className="sales-dash__user-action">{switchLabel}</span>
                </span>
                <span className="sales-dash__user-switch-chevron" aria-hidden>
                  <IconChevronDown />
                </span>
              </>
            ) : (
              <span className="sales-dash__user-switch-collapsed-icon" aria-hidden>
                <IconUserSwitch />
              </span>
            )}
          </button>
        </div>
      </aside>
      <div className="sales-dash__main">
        <Outlet />
      </div>
    </div>
  )
}
