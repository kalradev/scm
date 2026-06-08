import { Navigate, useParams } from 'react-router-dom'
import { AdminWorkflowPanel } from '../components/AdminWorkflowPanel'
import type { AdminDeptFilter } from '../lib/adminPipelineMetrics'

const DEPTS: readonly AdminDeptFilter[] = ['sales', 'finance', 'scm']

export function AdminDepartmentPage() {
  const { dept } = useParams<{ dept: string }>()

  if (!dept || !DEPTS.includes(dept as AdminDeptFilter)) {
    return <Navigate to="/admin" replace />
  }

  const d = dept as AdminDeptFilter

  return (
    <div className="admin-dash-view">
      <AdminWorkflowPanel department={d} />
    </div>
  )
}
