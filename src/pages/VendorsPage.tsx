import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import type { VendorAddress, VendorEntry } from '../types/vendor'
import {
  deleteVendorForUser,
  listVendorsForUser,
  updateVendorForUser,
} from '../lib/vendorsStorage'

function newAddr(): VendorAddress {
  return { id: crypto.randomUUID(), label: '', lines: '' }
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  )
}

export function VendorsPage() {
  const { user } = useAuth()
  const [version, setVersion] = useState(0)

  const vendors = useMemo(() => {
    void version
    if (!user) return []
    return listVendorsForUser(user.oid)
  }, [user, version])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  const saveVendor = useCallback(
    (v: VendorEntry) => {
      if (!user) return
      if (!v.name.trim()) return
      const cleaned: VendorEntry = {
        ...v,
        name: v.name.trim(),
        addresses: v.addresses
          .map((a) => ({
            ...a,
            label: '',
            lines: a.lines.trim(),
          }))
          .filter((a) => a.lines.length > 0),
      }
      if (cleaned.addresses.length === 0) return
      updateVendorForUser(user.oid, cleaned)
      refresh()
    },
    [user, refresh],
  )

  const handleDelete = useCallback(
    (id: string) => {
      if (!user) return
      if (!window.confirm('Delete this vendor and all saved addresses for them?')) return
      deleteVendorForUser(id, user.oid)
      refresh()
    },
    [user, refresh],
  )

  if (!user) {
    return <Navigate to="/sales" replace />
  }

  return (
    <section className="panel vendors-page">
      <p className="panel__back">
        <Link to="/sales" className="link-back">
          ← Back to Sales
        </Link>
      </p>
      <header className="vendors-page__head vendors-page__head--row">
        <div className="vendors-page__head-text">
          <h2 className="vendors-page__title">Vendors</h2>
        </div>
        <Link
          to="/sales/vendors/new"
          className="vendors-page__add-vendor-btn"
          title="Add vendor"
          aria-label="Add vendor"
        >
          <span className="vendors-page__add-vendor-icon" aria-hidden>
            <IconPlus />
          </span>
        </Link>
      </header>

      <h3 className="vendors-page__section-title vendors-page__section-title--list">Your vendors</h3>
      {vendors.length === 0 ? (
        <p className="muted vendors-page__empty">No vendors yet.</p>
      ) : (
        <div className="vendors-page__table-wrap">
          <table className="vendors-page__table">
            <thead>
              <tr>
                <th scope="col" className="vendors-page__th vendors-page__th--name">
                  Vendor
                </th>
                <th scope="col" className="vendors-page__th vendors-page__th--lines">
                  Address
                </th>
                <th scope="col" className="vendors-page__th vendors-page__th--actions" />
              </tr>
            </thead>
            {vendors.map((v) => (
              <VendorEditorTableBody
                key={v.id}
                vendor={v}
                onSave={saveVendor}
                onDelete={() => handleDelete(v.id)}
              />
            ))}
          </table>
        </div>
      )}
    </section>
  )
}

function VendorEditorTableBody({
  vendor,
  onSave,
  onDelete,
}: {
  vendor: VendorEntry
  onSave: (v: VendorEntry) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<VendorEntry>(vendor)

  useEffect(() => {
    setDraft(vendor)
  }, [vendor.id, vendor.updatedAt])

  const patchAddr = (id: string, patch: Partial<VendorAddress>) => {
    setDraft((d) => ({
      ...d,
      addresses: d.addresses.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }))
  }

  const addAddress = () => {
    setDraft((d) => ({
      ...d,
      addresses: [...d.addresses, newAddr()],
    }))
  }

  const removeAddress = (id: string) => {
    setDraft((d) => ({
      ...d,
      addresses: d.addresses.filter((a) => a.id !== id),
    }))
  }

  const addrs = draft.addresses
  const rowSpan = addrs.length + 1

  return (
    <tbody className="vendors-page__vendor-tbody">
      {addrs.map((a, index) => (
        <tr key={a.id} className="vendors-page__data-row">
          {index === 0 ? (
            <td rowSpan={rowSpan} className="vendors-page__td vendors-page__td--name">
              <input
                type="text"
                className="field__control vendors-page__table-input"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                aria-label="Vendor name"
              />
            </td>
          ) : null}
          <td className="vendors-page__td vendors-page__td--lines">
            <textarea
              className="field__control vendors-page__table-textarea"
              rows={2}
              value={a.lines}
              onChange={(e) => patchAddr(a.id, { lines: e.target.value })}
              aria-label="Address lines"
            />
          </td>
          <td className="vendors-page__td vendors-page__td--actions">
            <button
              type="button"
              className="btn btn-ghost btn--compact"
              onClick={() => removeAddress(a.id)}
              disabled={addrs.length <= 1}
              title={addrs.length <= 1 ? 'Keep at least one address' : 'Remove this address'}
            >
              Remove
            </button>
          </td>
        </tr>
      ))}
      <tr className="vendors-page__toolbar-row">
        <td colSpan={2} className="vendors-page__td vendors-page__td--toolbar">
          <div className="vendors-page__toolbar-inner">
            <button type="button" className="btn btn-ghost btn--compact" onClick={addAddress}>
              <span className="vendors-page__toolbar-plus" aria-hidden>
                <IconPlus />
              </span>
              Add address
            </button>
            <span className="vendors-page__toolbar-gap" aria-hidden />
            <button type="button" className="btn btn-primary btn--compact" onClick={() => onSave(draft)}>
              Save changes
            </button>
            <button type="button" className="btn btn-ghost btn--compact" onClick={onDelete}>
              Delete vendor
            </button>
          </div>
        </td>
      </tr>
    </tbody>
  )
}
