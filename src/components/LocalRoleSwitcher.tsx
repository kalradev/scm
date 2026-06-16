import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { ROLE_LABELS, ROLES, roleHomePath, type Role } from '../types/roles'

type Props = {
  variant?: 'login' | 'header'
}

function mapSwitchError(message: string): string {
  switch (message) {
    case 'invalid_role':
      return 'That role is not available.'
    case 'dev_switch_failed':
      return 'Could not switch role. Is the API running (npm run dev)?'
    default:
      return message
  }
}

export function LocalRoleSwitcher({ variant = 'login' }: Props) {
  const { user, loginAsRole, mode } = useAuth()
  const navigate = useNavigate()
  const [role, setRole] = useState<Role>(user?.role ?? 'sales')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (mode !== 'local' || !loginAsRole) return null
  const switchRole = loginAsRole

  async function enterAs(next: Role) {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await switchRole(next)
      navigate(roleHomePath(next), { replace: true })
    } catch (err) {
      setError(mapSwitchError(err instanceof Error ? err.message : 'dev_switch_failed'))
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'header') {
    return (
      <label className="role-switcher role-switcher--header">
        <span className="visually-hidden">Switch role</span>
        <select
          className="role-switcher__select role-switcher__select--header"
          value={user?.role ?? role}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as Role
            setRole(next)
            void enterAs(next)
          }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <div className="login-form">
      <label className="field">
        <span className="field__label">Role</span>
        <select
          className="field__control role-switcher__select"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={busy}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="login-card__error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-primary login-form__submit login-form__submit--prominent"
        disabled={busy}
        onClick={() => void enterAs(role)}
      >
        {busy ? 'Entering…' : 'Enter workspace'}
      </button>
    </div>
  )
}
