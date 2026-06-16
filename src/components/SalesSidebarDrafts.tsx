import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { formatQuoteDateDisplay } from '../lib/senderAddresses'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import {
  isQuoteDraft,
  listSavedQuotesForUser,
  SAVED_QUOTES_LOCAL_STORAGE_KEY,
  SAVED_QUOTES_UPDATED_EVENT,
} from '../lib/savedQuotesStorage'
import type { QuoteFormData } from '../types/quotePdf'

function linkClass(isActive: boolean): string {
  return `sales-dash__nav-link sales-dash__nav-link--drafts${isActive ? ' sales-dash__nav-link--active' : ''}`
}

function IconDraft() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
      />
    </svg>
  )
}

type Props = {
  collapsed: boolean
}

export function SalesSidebarDrafts({ collapsed }: Props) {
  const { user } = useAuth()
  const { pathname, search } = useLocation()
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_QUOTES_LOCAL_STORAGE_KEY) refresh()
    }
    const onUpdated = () => refresh()
    window.addEventListener('storage', onStorage)
    window.addEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    }
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [pathname, search, refresh])

  const drafts = useMemo(() => {
    if (!user) return []
    void tick
    return listSavedQuotesForUser(user.oid)
      .filter(isQuoteDraft)
      .sort(
        (a, b) =>
          new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
      )
  }, [user, tick])

  const draftsNavActive =
    pathname === '/sales/drafts' ||
    (pathname === '/sales/quote/new' && search.includes('draft='))

  return (
    <>
      <NavLink
        to="/sales/drafts"
        className={linkClass(draftsNavActive)}
        title={`Draft quotes${drafts.length > 0 ? ` (${drafts.length})` : ''}`}
        aria-label={
          collapsed
            ? `Draft quotes, ${drafts.length}`
            : undefined
        }
      >
        <span className="sales-dash__nav-icon">
          <IconDraft />
        </span>
        <span className="sales-dash__nav-text">Draft quotes</span>
        {drafts.length > 0 ? (
          <span
            className={`sales-dash__draft-badge${collapsed ? ' sales-dash__draft-badge--collapsed' : ''}`}
          >
            {drafts.length}
          </span>
        ) : null}
      </NavLink>

      {!collapsed && drafts.length > 0 ? (
        <ul className="sales-dash__draft-list">
          {drafts.map((row) => {
            const form = normalizeQuoteFormData(
              row.formSnapshot as QuoteFormData & { customerTitle?: string },
            )
            const label = form.customerName.trim() || 'Untitled draft'
            const editing =
              pathname === '/sales/quote/new' &&
              search.includes(`draft=${encodeURIComponent(row.id)}`)
            return (
              <li key={row.id}>
                <Link
                  to={`/sales/quote/new?draft=${row.id}`}
                  className={`sales-dash__draft-item${editing ? ' sales-dash__draft-item--active' : ''}`}
                  title={label}
                >
                  <span className="sales-dash__draft-item-title">{label}</span>
                  <span className="sales-dash__draft-item-meta">
                    {formatQuoteDateDisplay(row.formSnapshot.quoteDate)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : null}
    </>
  )
}
