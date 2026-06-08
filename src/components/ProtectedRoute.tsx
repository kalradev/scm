import { Navigate, useLocation } from 'react-router-dom'
import type { Role } from '../types/roles'
import { roleHomePath } from '../types/roles'
import { useAuth } from '../context/useAuth'

type Props = {
  allowed: readonly Role[]
  children: React.ReactNode
}

export function ProtectedRoute({ allowed, children }: Props) {
  const { user, status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  if (!user) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    )
  }

  if (user.role === null) {
    return <Navigate to="/awaiting-role" replace />
  }

  if (!allowed.includes(user.role)) {
    return <Navigate to={roleHomePath(user.role)} replace />
  }

  return <>{children}</>
}
