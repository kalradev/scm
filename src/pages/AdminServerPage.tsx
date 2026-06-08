import { useCallback, useEffect, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { fetchAdminQuoteRegistry } from '../api/quoteRegistryApi'
import { AdminQuotesTable } from '../components/AdminQuotesTable'
import {
  ADMIN_DELIVERY_ALERT_DAYS,
  adminRegistryEmptyHint,
  AdminHeroKpis,
  AdminPoDeliveryAlertsPanel,
} from '../components/admin/AdminServerSummary'
import { loginRequest } from '../auth/msalConfig'
import { useAuth } from '../context/useAuth'
import type { QuoteRegistryRow } from '../types/quoteRegistry'
import { listScmPoDeliveryAlerts } from '../lib/scmDeliveryAlerts'

function AdminServerLocal() {
  const [quotes, setQuotes] = useState<QuoteRegistryRow[]>([])
  const [quotesLoading, setQuotesLoading] = useState(true)
  const [quotesError, setQuotesError] = useState<string | null>(null)
  const hasSecret = Boolean(import.meta.env.VITE_SCM_INTERNAL_SECRET?.trim())

  const load = useCallback(() => {
    if (!hasSecret) {
      setQuotesLoading(false)
      return
    }
    setQuotesLoading(true)
    setQuotesError(null)
    fetchAdminQuoteRegistry()
      .then(setQuotes)
      .catch(() => {
        setQuotesError('Could not load quote registry.')
        setQuotes([])
      })
      .finally(() => setQuotesLoading(false))
  }, [hasSecret])

  useEffect(() => {
    load()
  }, [load])

  const deliveryDueCount = listScmPoDeliveryAlerts(ADMIN_DELIVERY_ALERT_DAYS).length

  return (
    <div className="admin-dash-view">
      <header className="admin-dash__head">
        <h1 className="admin-dash__page-title">Server</h1>
        <button type="button" className="btn btn-ghost" onClick={() => load()}>
          Refresh
        </button>
      </header>
      <div className="card-surface admin-dash__server-card">
        <AdminHeroKpis
          quotesCount={quotes.length}
          quotesLoading={quotesLoading}
          deliveryDueCount={deliveryDueCount}
        />
      </div>
      <AdminPoDeliveryAlertsPanel />
      <AdminQuotesTable
        quotes={quotes}
        loading={quotesLoading}
        error={quotesError}
        emptyHint={adminRegistryEmptyHint(hasSecret)}
      />
    </div>
  )
}

function AdminServerAzure() {
  const { instance, accounts } = useMsal()
  const [quotes, setQuotes] = useState<QuoteRegistryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [quotesError, setQuotesError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (accounts.length === 0) {
      setQuotes([])
      setLoading(false)
      return
    }
    setLoading(true)
    setQuotesError(null)
    try {
      const silent = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      })
      const rows = await fetchAdminQuoteRegistry(silent.accessToken)
      setQuotes(rows)
    } catch {
      setQuotesError('Could not load quote registry.')
      setQuotes([])
    } finally {
      setLoading(false)
    }
  }, [accounts, instance])

  useEffect(() => {
    void load()
  }, [load])

  const deliveryDueCount = listScmPoDeliveryAlerts(ADMIN_DELIVERY_ALERT_DAYS).length

  return (
    <div className="admin-dash-view">
      <header className="admin-dash__head">
        <h1 className="admin-dash__page-title">Server</h1>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      <div className="card-surface admin-dash__server-card">
        <AdminHeroKpis
          quotesCount={quotes.length}
          quotesLoading={loading}
          deliveryDueCount={deliveryDueCount}
        />
      </div>
      <AdminPoDeliveryAlertsPanel />
      <AdminQuotesTable
        quotes={quotes}
        loading={loading}
        error={quotesError}
        emptyHint="No quotes in the registry yet."
      />
    </div>
  )
}

export function AdminServerPage() {
  const { mode } = useAuth()
  if (mode === 'local') {
    return <AdminServerLocal />
  }
  return <AdminServerAzure />
}
