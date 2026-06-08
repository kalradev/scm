import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { roleHomePath } from '../types/roles'

type Props = {
  children: React.ReactNode
}

export function AdminRoute({ children }: Props) {
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

  if (user.role !== 'admin' && !user.isAdmin) {
    return <Navigate to={roleHomePath(user.role)} replace />
  }

  return <>{children}</>
}
