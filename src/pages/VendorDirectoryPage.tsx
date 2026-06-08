import { useMemo } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { resolveQuoteSavedByDisplayName } from '../lib/savedQuotesStorage'
import { listVendorDirectoryRows } from '../lib/vendorsStorage'

function formatAddr(lines: string): string {
  return String(lines ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ')
}

export function VendorDirectoryPage() {
  const { user } = useAuth()

  const rows = useMemo(() => {
    const raw = listVendorDirectoryRows()
    return [...raw].sort((a, b) => {
      const oa = resolveQuoteSavedByDisplayName(a.directoryOwnerOid)
      const ob = resolveQuoteSavedByDisplayName(b.directoryOwnerOid)
      const c = oa.localeCompare(ob, undefined, { sensitivity: 'base' })
      if (c !== 0) return c
      return a.vendor.name.localeCompare(b.vendor.name, undefined, {
        sensitivity: 'base',
      })
    })
  }, [])

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (user.role !== 'scm' && user.role !== 'finance') {
    return <Navigate to="/" replace />
  }

  const home = user.role === 'scm' ? '/scm' : '/finance'
  const homeLabel = user.role === 'scm' ? 'SCM workspace' : 'Finance workspace'
  const addVendorTo =
    user.role === 'scm' ? '/scm/vendors/new' : '/finance/vendors/new'

  return (
    <section className="panel vendor-directory-page">
      <p className="panel__back">
        <Link to={home} className="link-back">
          ← {homeLabel}
        </Link>
      </p>
      <header className="vendor-directory-page__head vendor-directory-page__head--row">
        <h2 className="vendor-directory-page__title">Vendor directory</h2>
        <Link to={addVendorTo} className="btn btn-primary vendor-directory-page__add-vendor">
          Add vendor
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="muted vendor-directory-page__empty">No entries yet.</p>
      ) : (
        <div className="vendor-directory-page__table-wrap">
          <table className="vendor-directory-page__table">
            <thead>
              <tr>
                <th scope="col">Sales directory owner</th>
                <th scope="col">Vendor</th>
                <th scope="col">Addresses</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ vendor, directoryOwnerOid }) => (
                <tr key={`${directoryOwnerOid}:${vendor.id}`}>
                  <td>{resolveQuoteSavedByDisplayName(directoryOwnerOid)}</td>
                  <td>{vendor.name.trim() || '—'}</td>
                  <td>
                    <ul className="vendor-directory-page__addr-list">
                      {vendor.addresses.map((a) => (
                        <li key={a.id}>{formatAddr(a.lines) || '—'}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
