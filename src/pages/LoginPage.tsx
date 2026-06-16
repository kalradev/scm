import { Navigate } from 'react-router-dom'
import { LocalRoleSwitcher } from '../components/LocalRoleSwitcher'
import { useAuth } from '../context/useAuth'

export function LoginPage() {
  const { mode, status, user, login, lastError } = useAuth()

  if (mode === 'local') {
    if (user?.role) {
      return <Navigate to="/" replace />
    }

    if (status === 'loading') {
      return (
        <div className="login-page login-page--ambient">
          <div className="login-loading card-surface">
            <div className="login-loading__spinner" aria-hidden />
            <p className="login-loading__text">Restoring session…</p>
          </div>
        </div>
      )
    }

    return (
      <div className="login-page login-page--ambient">
        <div className="login-shell">
          <div className="login-card login-card--microsoft">
            <div className="login-mark" aria-hidden>
              <span className="login-mark__badge">SCM</span>
            </div>
            <h2 className="login-card__title">Choose a role</h2>
            <p className="login-card__lead">
              Pick Sales, Finance, SCM, or Admin to enter the workspace — no password needed
              during local development.
            </p>
            {lastError ? (
              <p className="login-card__error" role="alert">
                {lastError}
              </p>
            ) : null}
            <LocalRoleSwitcher variant="login" />
          </div>
        </div>
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <div className="login-page login-page--ambient">
        <div className="login-loading card-surface">
          <div className="login-loading__spinner" aria-hidden />
          <p className="login-loading__text">Signing you in…</p>
        </div>
      </div>
    )
  }

  if (user?.role) {
    return <Navigate to="/" replace />
  }

  if (user && user.role === null) {
    return <Navigate to="/awaiting-role" replace />
  }

  return (
    <div className="login-page login-page--ambient">
      <div className="login-shell">
        <div className="login-card login-card--microsoft">
          <div className="login-mark" aria-hidden>
            <span className="login-mark__badge">SCM</span>
          </div>
          <h2 className="login-card__title">Sign in</h2>
          <p className="login-card__lead">Use your Microsoft work account.</p>
          {lastError ? (
            <p className="login-card__error" role="alert">
              {lastError}
            </p>
          ) : null}
          <div className="login-form">
            <button
              type="button"
              className="btn login-ms-btn"
              onClick={() => void login?.()}
            >
              <svg className="login-ms-btn__logo" viewBox="0 0 23 23" aria-hidden>
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
              Sign in with Microsoft
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
