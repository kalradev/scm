import { type FormEvent, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { fetchLocalAuthStatus } from '../api/authApi'
import { useAuth } from '../context/useAuth'

function mapAuthError(message: string): string {
  switch (message) {
    case 'invalid_credentials':
      return 'Invalid user ID or password.'
    case 'username_taken':
      return 'That user ID is already in use.'
    case 'already_initialized':
      return 'An administrator account already exists.'
    case 'local_status_failed':
      return 'Could not reach the server. Start the API (npm run dev) and try again.'
    default:
      return message
  }
}

export function LoginPage() {
  const {
    mode,
    status,
    user,
    login,
    loginWithCredentials,
    registerFirstAdmin,
    lastError,
  } = useAuth()

  const [localBoot, setLocalBoot] = useState<{
    loaded: boolean
    hasUsers: boolean
  }>({ loaded: false, hasUsers: true })
  const [bootError, setBootError] = useState<string | null>(null)
  const [statusAttempt, setStatusAttempt] = useState(0)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** Single primitive dep so the effect’s dependency array length never changes (avoids Fast Refresh glitches when deps are edited). */
  const localAuthBootKey =
    mode === 'local' && !user ? `boot:${statusAttempt}` : ''

  useEffect(() => {
    if (!localAuthBootKey) return
    let cancelled = false
    setLocalBoot({ loaded: false, hasUsers: true })
    setBootError(null)
    fetchLocalAuthStatus()
      .then((s) => {
        if (!cancelled) {
          setBootError(null)
          setLocalBoot({ loaded: true, hasUsers: s.hasUsers })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBootError(mapAuthError('local_status_failed'))
          setLocalBoot({ loaded: true, hasUsers: false })
        }
      })
    return () => {
      cancelled = true
    }
  }, [localAuthBootKey])

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

    if (!localBoot.loaded) {
      return (
        <div className="login-page login-page--ambient">
          <div className="login-loading card-surface">
            <div className="login-loading__spinner" aria-hidden />
            <p className="login-loading__text">Connecting…</p>
          </div>
        </div>
      )
    }

    if (bootError) {
      return (
        <div className="login-page login-page--ambient">
          <div className="login-shell">
            <div className="login-card login-card--microsoft">
              <div className="login-mark" aria-hidden>
                <span className="login-mark__badge">SCM</span>
              </div>
              <h2 className="login-card__title">Server unavailable</h2>
              <p className="login-card__error" role="alert">
                {bootError}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStatusAttempt((n) => n + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )
    }

    const showSetup = !localBoot.hasUsers

    async function handleLogin(e: FormEvent) {
      e.preventDefault()
      if (!loginWithCredentials) return
      setFormError(null)
      setSubmitting(true)
      try {
        await loginWithCredentials(username.trim(), password)
      } catch (err) {
        setFormError(
          mapAuthError(err instanceof Error ? err.message : 'sign_in_failed'),
        )
      } finally {
        setSubmitting(false)
      }
    }

    async function handleFirstAdmin(e: FormEvent) {
      e.preventDefault()
      if (!registerFirstAdmin) return
      setFormError(null)
      setSubmitting(true)
      try {
        await registerFirstAdmin({
          username: username.trim(),
          password,
          displayName: displayName.trim() || username.trim(),
          email: email.trim(),
        })
      } catch (err) {
        setFormError(
          mapAuthError(err instanceof Error ? err.message : 'register_failed'),
        )
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <div className="login-page login-page--ambient">
        <div className="login-shell">
          <div className="login-card login-card--microsoft">
            <div className="login-mark" aria-hidden>
              <span className="login-mark__badge">SCM</span>
            </div>
            <h2 className="login-card__title">
              {showSetup ? 'Create administrator' : 'Sign in'}
            </h2>
            <p className="login-card__lead">
              {showSetup
                ? 'No accounts exist yet. Create the first admin user ID and password, then add other users and roles from Admin → Users.'
                : 'Sign in with the user ID and password your administrator created.'}
            </p>
            {(formError || lastError) ? (
              <p className="login-card__error" role="alert">
                {formError || lastError}
              </p>
            ) : null}

            {showSetup ? (
              <form className="login-form" onSubmit={handleFirstAdmin}>
                <label className="field">
                  <span className="field__label">User ID</span>
                  <input
                    className="field__control"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    minLength={2}
                    maxLength={64}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Password</span>
                  <input
                    className="field__control"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={4}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Display name</span>
                  <input
                    className="field__control"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    maxLength={120}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Email (optional)</span>
                  <input
                    className="field__control"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    maxLength={200}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary login-form__submit login-form__submit--prominent"
                  disabled={submitting}
                >
                  {submitting ? 'Creating…' : 'Create admin & sign in'}
                </button>
              </form>
            ) : (
              <form className="login-form" onSubmit={handleLogin} autoComplete="off">
                {/* Prevent Chrome/password managers from auto-filling saved credentials. */}
                <input
                  type="text"
                  name="fake-username"
                  autoComplete="username"
                  tabIndex={-1}
                  aria-hidden="true"
                  style={{ position: 'absolute', opacity: 0, height: 0, width: 0, pointerEvents: 'none' }}
                />
                <input
                  type="password"
                  name="fake-password"
                  autoComplete="current-password"
                  tabIndex={-1}
                  aria-hidden="true"
                  style={{ position: 'absolute', opacity: 0, height: 0, width: 0, pointerEvents: 'none' }}
                />
                <label className="field">
                  <span className="field__label">User ID</span>
                  <input
                    className="field__control"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    name="scm-local-username"
                    autoComplete="off"
                    required
                    minLength={2}
                    maxLength={64}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Password</span>
                  <input
                    className="field__control"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    name="scm-local-password"
                    autoComplete="off"
                    required
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary login-form__submit login-form__submit--prominent"
                  disabled={submitting}
                >
                  {submitting ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}

            {showSetup ? (
              <div className="login-form" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setStatusAttempt((n) => n + 1)}
                  disabled={submitting}
                >
                  I already have an account — check again
                </button>
              </div>
            ) : null}
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
