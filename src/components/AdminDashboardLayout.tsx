import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

const SIDEBAR_KEY = 'scm_admin_sidebar_collapsed'

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
        d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m0-12.75V3m0 12.75V18m-9-1.5h.008v.008H9.75v-.008z"
      />
    </svg>
  )
}

function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 19.128a9 9 0 002.905.09 8.999 8.999 0 004.72-2.645M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
      />
    </svg>
  )
}

function IconDept({ letter }: { letter: string }) {
  return (
    <span className="admin-dash__nav-letter" aria-hidden>
      {letter}
    </span>
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

export function AdminDashboardLayout() {
  const { user, switchAccount, mode } = useAuth()
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_KEY) === '1'
  })

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c)
  }, [])

  const initials = user?.displayName ? userInitials(user.displayName) : '?'
  const switchLabel = mode === 'azure' ? 'Switch account' : 'Switch user'

  return (
    <div className="sales-dash admin-dash">
      <aside
        className={`sales-dash__sidebar${collapsed ? ' sales-dash__sidebar--collapsed' : ''}`}
        aria-label="Admin dashboard"
      >
        <div className="sales-dash__sidebar-top">
          <button
            type="button"
            className="sales-dash__sidebar-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="admin-dash-nav"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <span className="sales-dash__sidebar-toggle-icon" aria-hidden>
              <IconChevron direction={collapsed ? 'right' : 'left'} />
            </span>
          </button>
          <p
            id="admin-dash-label"
            className={`sales-dash__sidebar-heading${collapsed ? ' sales-dash__sidebar-heading--vh' : ''}`}
          >
            Admin
          </p>
        </div>

        <nav id="admin-dash-nav" className="sales-dash__nav" aria-labelledby="admin-dash-label">
          <NavLink
            to="/admin"
            end
            className={({ isActive }) => linkClass(isActive)}
          >
            <span className="sales-dash__nav-icon">
              <IconOverview />
            </span>
            <span className="sales-dash__nav-text">Overview</span>
          </NavLink>
          <NavLink
            to="/admin/sales"
            className={({ isActive }) => linkClass(isActive)}
          >
            <span className="sales-dash__nav-icon">
              <IconDept letter="S" />
            </span>
            <span className="sales-dash__nav-text">Sales</span>
          </NavLink>
          <NavLink
            to="/admin/finance"
            className={({ isActive }) => linkClass(isActive)}
          >
            <span className="sales-dash__nav-icon">
              <IconDept letter="F" />
            </span>
            <span className="sales-dash__nav-text">Finance</span>
          </NavLink>
          <NavLink
            to="/admin/scm"
            className={({ isActive }) => linkClass(isActive)}
          >
            <span className="sales-dash__nav-icon">
              <IconDept letter="C" />
            </span>
            <span className="sales-dash__nav-text">SCM</span>
          </NavLink>
          <NavLink
            to="/admin/users"
            className={({ isActive }) => linkClass(isActive)}
          >
            <span className="sales-dash__nav-icon">
              <IconUsers />
            </span>
            <span className="sales-dash__nav-text">Users</span>
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
        </div>
      </aside>
      <div className="sales-dash__main admin-dash__main">
        <Outlet />
      </div>
    </div>
  )
}
