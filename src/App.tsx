import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'
import { AppLayout } from './components/AppLayout'
import { FinanceDashboardLayout } from './components/FinanceDashboardLayout'
import { SalesDashboardLayout } from './components/SalesDashboardLayout'
import { ScmDashboardLayout } from './components/ScmDashboardLayout'
import { AdminRoute } from './components/AdminRoute'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AdminDashboardLayout } from './components/AdminDashboardLayout'
import { AdminDepartmentPage } from './pages/AdminDepartmentPage'
import { AdminOverviewPage } from './pages/AdminOverviewPage'
import { AdminServerPage } from './pages/AdminServerPage'
import { AdminUsersPage } from './pages/AdminUsersPage'
import { AwaitingRolePage } from './pages/AwaitingRolePage'
import { FinanceHome } from './pages/FinanceHome'
import { FinanceQuoteWorkflowDetailsPage } from './pages/FinanceQuoteWorkflowDetailsPage'
import { LoginPage } from './pages/LoginPage'
import { InvoiceToQuotePage } from './pages/InvoiceToQuotePage'
import { NewQuotePage } from './pages/NewQuotePage'
import { OvfEntryPage } from './pages/OvfEntryPage'
import { QuotePoPage } from './pages/QuotePoPage'
import { SalesHome } from './pages/SalesHome'
import { SalesDraftsPage } from './pages/SalesDraftsPage'
import { ScmHome } from './pages/ScmHome'
import { ScmPoPage } from './pages/ScmPoPage'
import { ScmPurchaseOrdersPage } from './pages/ScmPurchaseOrdersPage'
import { ScmVendorsPoPage } from './pages/ScmVendorsPoPage'
import { VendorDirectoryPage } from './pages/VendorDirectoryPage'
import { VendorNewPage } from './pages/VendorNewPage'
import { VendorsPage } from './pages/VendorsPage'
import { roleHomePath } from './types/roles'

function RootRedirect() {
  const { status, user } = useAuth()

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

  if (user.role === null) {
    return <Navigate to="/awaiting-role" replace />
  }

  return <Navigate to={roleHomePath(user.role)} replace />
}

function SalesLayout() {
  return (
    <ProtectedRoute allowed={['sales']}>
      <AppLayout workspace="sales" mainClassName="app-main--sales-dash">
        <SalesDashboardLayout />
      </AppLayout>
    </ProtectedRoute>
  )
}

function FinanceLayout() {
  return (
    <ProtectedRoute allowed={['finance']}>
      <AppLayout workspace="finance" mainClassName="app-main--finance-dash">
        <FinanceDashboardLayout />
      </AppLayout>
    </ProtectedRoute>
  )
}

function ScmLayout() {
  return (
    <ProtectedRoute allowed={['scm']}>
      <AppLayout workspace="scm" mainClassName="app-main--scm-dash">
        <ScmDashboardLayout />
      </AppLayout>
    </ProtectedRoute>
  )
}

function AdminAppShell() {
  return (
    <AdminRoute>
      <AppLayout workspace="admin" mainClassName="app-main--admin-dash">
        <AdminDashboardLayout />
      </AppLayout>
    </AdminRoute>
  )
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/awaiting-role', element: <AwaitingRolePage /> },
  {
    path: '/admin',
    element: <AdminAppShell />,
    children: [
      { index: true, element: <AdminOverviewPage /> },
      { path: 'users', element: <AdminUsersPage /> },
      { path: 'server', element: <AdminServerPage /> },
      { path: ':dept', element: <AdminDepartmentPage /> },
    ],
  },
  {
    path: '/sales',
    element: <SalesLayout />,
    children: [
      { index: true, element: <SalesHome /> },
      { path: 'drafts', element: <SalesDraftsPage /> },
      { path: 'vendors/new', element: <VendorNewPage /> },
      { path: 'vendors', element: <VendorsPage /> },
      { path: 'quote/from-invoice', element: <InvoiceToQuotePage /> },
      { path: 'quote/new', element: <NewQuotePage /> },
      { path: 'q/:quoteId', element: <QuotePoPage /> },
      { path: 'q/:quoteId/ovf', element: <OvfEntryPage mode="sales" /> },
    ],
  },
  {
    path: '/finance',
    element: <FinanceLayout />,
    children: [
      { index: true, element: <FinanceHome /> },
      { path: 'vendors/new', element: <VendorNewPage /> },
      { path: 'vendors', element: <VendorDirectoryPage /> },
      { path: 'q/:quoteId/workflow', element: <FinanceQuoteWorkflowDetailsPage /> },
      { path: 'q/:quoteId/ovf', element: <OvfEntryPage mode="finance" /> },
    ],
  },
  {
    path: '/scm',
    element: <ScmLayout />,
    children: [
      { index: true, element: <ScmHome /> },
      { path: 'vendor-po', element: <ScmVendorsPoPage /> },
      { path: 'purchase-orders', element: <ScmPurchaseOrdersPage /> },
      { path: 'po/new', element: <Navigate to="/scm" replace /> },
      { path: 'vendors/new', element: <VendorNewPage /> },
      { path: 'vendors', element: <VendorDirectoryPage /> },
      { path: 'q/:quoteId/ovf', element: <OvfEntryPage mode="scm" /> },
      { path: 'q/:quoteId/po', element: <ScmPoPage /> },
    ],
  },
  { path: '/', element: <RootRedirect /> },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
