import { useState } from 'react'
import { AdminEntraAssignments } from '../components/admin/AdminEntraAssignments'
import { AdminLocalUserRoster } from '../components/admin/AdminLocalUserRoster'
import { useAuth } from '../context/useAuth'

export function AdminUsersPage() {
  const { mode } = useAuth()
  const [tick, setTick] = useState(0)

  return (
    <div className="admin-dash-view">
      <header className="admin-dash__head">
        <h1 className="admin-dash__page-title">Users</h1>
        {mode === 'local' ? (
          <button type="button" className="btn btn-ghost" onClick={() => setTick((n) => n + 1)}>
            Refresh
          </button>
        ) : null}
      </header>
      {mode === 'local' ? (
        <AdminLocalUserRoster version={tick} />
      ) : (
        <AdminEntraAssignments />
      )}
    </div>
  )
}
