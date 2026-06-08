import { useCallback, useEffect, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { fetchAssignments, putAssignment } from '../../api/authApi'
import { loginRequest } from '../../auth/msalConfig'
import { useAuth } from '../../context/useAuth'
import { ROLE_LABELS, ROLES, type Role } from '../../types/roles'

export function AdminEntraAssignments() {
  const { user } = useAuth()
  const { instance, accounts } = useMsal()
  const [assignments, setAssignments] = useState<Record<string, Role>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [oidInput, setOidInput] = useState('')
  const [roleInput, setRoleInput] = useState<Role>('sales')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (accounts.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const silent = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      })
      const assignData = await fetchAssignments(silent.accessToken)
      const next: Record<string, Role> = {}
      for (const [oid, r] of Object.entries(assignData.assignments)) {
        if (ROLES.includes(r as Role)) next[oid] = r as Role
      }
      setAssignments(next)
    } catch {
      setError('Could not load assignments.')
    } finally {
      setLoading(false)
    }
  }, [accounts, instance])

  useEffect(() => {
    void load()
  }, [load])

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault()
    const oid = oidInput.trim()
    if (!/^[0-9a-f-]{36}$/i.test(oid)) {
      setError('Object ID must be a GUID.')
      return
    }
    if (accounts.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const silent = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      })
      await putAssignment(silent.accessToken, oid, roleInput)
      setOidInput('')
      await load()
    } catch {
      setError('Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(oid: string) {
    if (!window.confirm('Remove role for this user?')) return
    if (accounts.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const silent = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      })
      await putAssignment(silent.accessToken, oid, null)
      await load()
    } catch {
      setError('Remove failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-entra card-surface admin-dash__server-card">
      <h2 className="admin-dashboard__section-title">Microsoft Entra</h2>
      {user ? (
        <p className="muted admin-dashboard__you">
          <strong>{user.email}</strong> ·{' '}
          <code className="login-code">{user.oid}</code>
        </p>
      ) : null}

      <form className="admin-dashboard__form" onSubmit={(e) => void handleAssign(e)}>
        <label className="field">
          <span className="field__label">Object ID</span>
          <input
            className="field__control"
            value={oidInput}
            onChange={(e) => setOidInput(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field__label">Department</span>
          <select
            className="field__control"
            value={roleInput}
            onChange={(e) => setRoleInput(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving || loading}>
          Save
        </button>
      </form>

      {error ? (
        <p className="admin-dashboard__error" role="alert">
          {error}
        </p>
      ) : null}

      <h3 className="admin-dashboard__table-title">Assignments</h3>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : Object.keys(assignments).length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="sales-dashboard__table-wrap">
          <table className="sales-dashboard__table">
            <thead>
              <tr>
                <th>Object ID</th>
                <th>Department</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(assignments).map(([oid, role]) => (
                <tr key={oid}>
                  <td>
                    <code className="login-code">{oid}</code>
                  </td>
                  <td>{ROLE_LABELS[role]}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={saving}
                      onClick={() => void handleRemove(oid)}
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
