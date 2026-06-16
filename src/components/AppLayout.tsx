import { Link, useLocation } from 'react-router-dom'
import { LocalRoleSwitcher } from './LocalRoleSwitcher'
import { useAuth } from '../context/useAuth'
import { ROLE_LABELS } from '../types/roles'

type WorkspaceTheme = 'sales' | 'finance' | 'scm' | 'admin'

type Props = {
  children: React.ReactNode
  /** Extra classes on `<main>` (e.g. full-width sales dashboard). */
  mainClassName?: string
  /** Tints header / shell for Sales, Finance, SCM, or Admin. */
  workspace?: WorkspaceTheme
}

export function AppLayout({ children, mainClassName, workspace }: Props) {
  const { user, logout, mode } = useAuth()
  const { pathname } = useLocation()
  const onAdminApp = pathname.startsWith('/admin')

  const mainClasses = ['app-main', mainClassName].filter(Boolean).join(' ')
  const shellClass = [
    'app-shell',
    workspace ? `app-shell--workspace-${workspace}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={shellClass}>
      <header className="app-header">
        <p className="app-header__center">SCM tool</p>
        <div className="app-header__user">
          {user ? (
            <>
              {mode === 'local' ? (
                <LocalRoleSwitcher variant="header" />
              ) : user.role ? (
                <span className="role-pill">{ROLE_LABELS[user.role]}</span>
              ) : (
                <span className="role-pill role-pill--pending">No role</span>
              )}
              {user.isAdmin && !onAdminApp ? (
                <Link to="/admin" className="app-header__admin-link">
                  Admin console
                </Link>
              ) : null}
              <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main className={mainClasses}>{children}</main>
    </div>
  )
}
