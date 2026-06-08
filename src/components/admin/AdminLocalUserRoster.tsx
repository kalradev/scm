import { useCallback, useEffect, useState } from 'react'
import {
  adminCreateLocalUser,
  adminDeleteLocalUser,
  adminListLocalUsers,
  LOCAL_SESSION_TOKEN_KEY,
} from '../../api/authApi'
import { ROLE_LABELS, ROLES, type Role } from '../../types/roles'

export function AdminLocalUserRoster({ version }: { version: number }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('sales')
  const [rows, setRows] = useState<
    Awaited<ReturnType<typeof adminListLocalUsers>>['users']
  >([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const token =
    typeof window !== 'undefined'
      ? sessionStorage.getItem(LOCAL_SESSION_TOKEN_KEY)
      : null

  const reload = useCallback(async () => {
    if (!token) {
      setRows([])
      setLoading(false)
      return
    }
    setLoadError(null)
    setLoading(true)
    try {
      const { users } = await adminListLocalUsers(token)
      setRows(users)
    } catch {
      setLoadError('Could not load users. Sign in again or check the API.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void reload()
  }, [reload, version])

  return (
    <div className="admin-local-roster card-surface admin-dash__server-card">
      <h2 className="admin-dashboard__section-title">User accounts</h2>
      <p className="muted admin-local-roster__hint">
        Create sign-in IDs and passwords here. Each user gets the workspace role you
        select (Sales, Finance, SCM, or Admin).
      </p>
      <form
        className="admin-dashboard__form admin-local-roster__form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!token) return
          if (!username.trim() || password.length < 4) return
          setSaveError(null)
          void (async () => {
            try {
              await adminCreateLocalUser(token, {
                username: username.trim(),
                password,
                role,
                displayName: displayName.trim() || username.trim(),
                email: email.trim(),
              })
              setUsername('')
              setPassword('')
              setDisplayName('')
              setEmail('')
              await reload()
            } catch (err) {
              const code = err instanceof Error ? err.message : 'create_failed'
              setSaveError(
                code === 'username_taken'
                  ? 'That user ID is already in use.'
                  : 'Could not create user.',
              )
            }
          })()
        }}
      >
        <label className="field">
          <span className="field__label">User ID</span>
          <input
            className="field__control"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={64}
            autoComplete="off"
            required
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
            minLength={4}
            required
          />
        </label>
        <label className="field">
          <span className="field__label">Display name</span>
          <input
            className="field__control"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={120}
            autoComplete="name"
          />
        </label>
        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="field__control"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            autoComplete="email"
          />
        </label>
        <label className="field">
          <span className="field__label">Role</span>
          <select
            className="field__control"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          Add user
        </button>
      </form>
      {saveError ? (
        <p className="login-card__error" role="alert">
          {saveError}
        </p>
      ) : null}
      {loadError ? (
        <p className="login-card__error" role="alert">
          {loadError}
        </p>
      ) : null}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No users.</p>
      ) : (
        <div className="sales-dashboard__table-wrap">
          <table className="sales-dashboard__table">
            <thead>
              <tr>
                <th scope="col">User ID</th>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Internal ID</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code className="login-code">{row.username}</code>
                  </td>
                  <td>{row.displayName || '—'}</td>
                  <td>{row.email || '—'}</td>
                  <td>{ROLE_LABELS[row.role]}</td>
                  <td>
                    <code className="login-code admin-local-roster__oid">{row.id}</code>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn--compact"
                      onClick={() => {
                        if (!token) return
                        if (
                          !window.confirm(
                            `Remove user «${row.username}»? They will no longer be able to sign in.`,
                          )
                        ) {
                          return
                        }
                        void (async () => {
                          try {
                            await adminDeleteLocalUser(token, row.id)
                            await reload()
                          } catch {
                            window.alert(
                              'Could not remove user (you cannot delete yourself or the last admin).',
                            )
                          }
                        })()
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
