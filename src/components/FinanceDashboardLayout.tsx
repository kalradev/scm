import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

const SIDEBAR_COLLAPSED_KEY = 'scm_finance_sidebar_collapsed'

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

function IconVendors() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12.75m-12.75 18h7.5m3-18v18m3-13.5V21"
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

export function FinanceDashboardLayout() {
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

  const vendorsDirActive = pathname.startsWith('/finance/vendors')
  const overviewActive =
    (pathname === '/finance' || pathname.startsWith('/finance/q/')) && !vendorsDirActive

  const initials = user?.displayName ? userInitials(user.displayName) : '?'
  const switchLabel = mode === 'azure' ? 'Switch account' : 'Switch user'

  return (
    <div className="sales-dash finance-dash">
      <aside
        className={`sales-dash__sidebar${collapsed ? ' sales-dash__sidebar--collapsed' : ''}`}
        aria-label="Finance workspace"
      >
        <div className="sales-dash__sidebar-top">
          <button
            type="button"
            className="sales-dash__sidebar-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="finance-dash-nav"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <span className="sales-dash__sidebar-toggle-icon" aria-hidden>
              <IconChevron direction={collapsed ? 'right' : 'left'} />
            </span>
          </button>
          <p
            id="finance-dash-workspace-label"
            className={`sales-dash__sidebar-heading${collapsed ? ' sales-dash__sidebar-heading--vh' : ''}`}
          >
            Finance
          </p>
        </div>

        <nav
          id="finance-dash-nav"
          className="sales-dash__nav"
          aria-labelledby="finance-dash-workspace-label"
        >
          <Link
            to="/finance"
            className={linkClass(overviewActive)}
            aria-current={overviewActive ? 'page' : undefined}
            title="Overview"
            aria-label={collapsed ? 'Overview' : undefined}
          >
            <span className="sales-dash__nav-icon">
              <IconOverview />
            </span>
            <span className="sales-dash__nav-text">Overview</span>
          </Link>
          <NavLink
            to="/finance/vendors"
            className={({ isActive }) => linkClass(isActive)}
            title="Vendor directory"
            aria-label={collapsed ? 'Vendor directory' : undefined}
          >
            <span className="sales-dash__nav-icon">
              <IconVendors />
            </span>
            <span className="sales-dash__nav-text">Vendor directory</span>
          </NavLink>
        </nav>

        <div className="sales-dash__sidebar-spacer" aria-hidden />

        <div className="sales-dash__sidebar-bottom">
          {mode === 'local' ? (
            <div className="sales-dash__user-switch sales-dash__user-switch--static">
              {!collapsed ? (
                <>
                  <span className="sales-dash__user-avatar" aria-hidden>
                    {initials}
                  </span>
                  <span className="sales-dash__user-text">
                    <span className="sales-dash__user-name">{user?.displayName ?? '—'}</span>
                  </span>
                </>
              ) : (
                <span className="sales-dash__user-avatar" aria-hidden>
                  {initials}
                </span>
              )}
            </div>
          ) : (
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
                    <span className="sales-dash__user-name">{user?.displayName ?? '—'}</span>
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
          )}
        </div>
      </aside>
      <div className="sales-dash__main">
        <Outlet />
      </div>
    </div>
  )
}
