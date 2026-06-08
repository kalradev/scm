import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { roleHomePath } from '../types/roles'

export function AwaitingRolePage() {
  const { mode, status, user, logout } = useAuth()

  if (mode === 'local') {
    return <Navigate to="/" replace />
  }

  if (status === 'loading') {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (user.role) {
    return <Navigate to={roleHomePath(user.role)} replace />
  }

  return (
    <div className="login-page">
      <div className="login-card login-card--wide">
        <h1 className="login-card__heading">Role not assigned</h1>
        <p className="login-card__sub muted">
          No role assigned. Ask an admin to map your Object ID, then refresh or sign in again.
        </p>
        <p className="login-card__sub muted">
          Your Object ID (for the admin):{' '}
          <code className="login-code">{user.oid}</code>
        </p>
        <div className="login-form login-form--row">
          {user.isAdmin ? (
            <Link to="/admin" className="btn btn-primary">
              Open admin dashboard
            </Link>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
