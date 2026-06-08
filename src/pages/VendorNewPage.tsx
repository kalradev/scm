import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import type { VendorAddress } from '../types/vendor'
import {
  listDistinctQuoteSavedByOids,
  resolveQuoteSavedByDisplayName,
} from '../lib/savedQuotesStorage'
import { createVendorForUser, listVendorDirectoryRows } from '../lib/vendorsStorage'

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

type VendorWorkspace = 'sales' | 'scm' | 'finance'

function workspaceFromPath(pathname: string): VendorWorkspace {
  if (pathname.startsWith('/scm')) return 'scm'
  if (pathname.startsWith('/finance')) return 'finance'
  return 'sales'
}

function vendorsListPath(ws: VendorWorkspace): string {
  if (ws === 'scm') return '/scm/vendors'
  if (ws === 'finance') return '/finance/vendors'
  return '/sales/vendors'
}

export function VendorNewPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const workspace = workspaceFromPath(pathname)
  const listPath = vendorsListPath(workspace)
  const pickOwner = workspace !== 'sales'

  const [newName, setNewName] = useState('')
  const [newAddresses, setNewAddresses] = useState<VendorAddress[]>(() => [newAddr()])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [directoryOwnerOid, setDirectoryOwnerOid] = useState('')

  const ownerOptions = useMemo(() => {
    const s = new Set<string>()
    for (const oid of listDistinctQuoteSavedByOids()) {
      s.add(oid)
    }
    for (const row of listVendorDirectoryRows()) {
      const oid = row.directoryOwnerOid.trim()
      if (oid) s.add(oid)
    }
    return [...s].sort((a, b) =>
      resolveQuoteSavedByDisplayName(a).localeCompare(
        resolveQuoteSavedByDisplayName(b),
        undefined,
        { sensitivity: 'base' },
      ),
    )
  }, [])

  useEffect(() => {
    if (!pickOwner) return
    setDirectoryOwnerOid((prev) => {
      if (prev && ownerOptions.includes(prev)) return prev
      return ownerOptions[0] ?? ''
    })
  }, [pickOwner, ownerOptions])

  const patchNewAddress = useCallback((id: string, patch: Partial<VendorAddress>) => {
    setNewAddresses((rows) =>
      rows.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    )
  }, [])

  const addNewAddressRow = useCallback(() => {
    setNewAddresses((rows) => [...rows, newAddr()])
  }, [])

  const removeNewAddressRow = useCallback((id: string) => {
    setNewAddresses((rows) => {
      if (rows.length <= 1) return rows
      return rows.filter((a) => a.id !== id)
    })
  }, [])

  const handleCreateVendor = useCallback(() => {
    if (!user) return
    setSaveError(null)
    const name = newName.trim()
    if (!name) {
      setSaveError('Enter a vendor name.')
      return
    }
    const targetSavedBy = pickOwner ? directoryOwnerOid.trim() : user.oid
    if (pickOwner && !targetSavedBy) {
      setSaveError('Choose which Sales directory should own this vendor (no owners found yet).')
      return
    }
    const rows = newAddresses.map((a) => ({
      label: '',
      lines: a.lines.trim(),
    }))
    if (!rows.some((r) => r.lines.length > 0)) {
      setSaveError('Add at least one address with text.')
      return
    }
    try {
      createVendorForUser(targetSavedBy, name, rows)
    } catch {
      setSaveError('Could not save vendor. Try again.')
      return
    }
    navigate(listPath)
  }, [
    user,
    newName,
    newAddresses,
    navigate,
    listPath,
    pickOwner,
    directoryOwnerOid,
  ])

  if (!user) {
    return <Navigate to="/login" replace />
  }

  const backLabel =
    workspace === 'scm'
      ? 'Vendor directory'
      : workspace === 'finance'
        ? 'Vendor directory'
        : 'Vendors'

  return (
    <section className="panel vendors-page vendors-page--new">
      <p className="panel__back">
        <Link to={listPath} className="link-back">
          ← {backLabel}
        </Link>
      </p>
      <header className="vendors-page__head">
        <h2 className="vendors-page__title">Add vendor</h2>
      </header>

      {saveError ? (
        <p className="vendors-page__form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="vendors-page__create">
        {pickOwner ? (
          <div className="vendors-page__create-grid vendors-page__create-grid--owner">
            <label className="field vendors-page__create-owner">
              <span className="field__label">Sales directory owner</span>
              {ownerOptions.length === 0 ? (
                <p className="muted vendors-page__owner-empty">
                  No Sales users found in saved data yet. Finalize a quote as Sales first, then
                  return here — or add vendors from the Sales workspace.
                </p>
              ) : (
                <>
                  <select
                    className="field__control"
                    value={directoryOwnerOid}
                    onChange={(e) => setDirectoryOwnerOid(e.target.value)}
                    aria-label="Sales directory owner"
                  >
                    {ownerOptions.map((oid) => (
                      <option key={oid} value={oid}>
                        {resolveQuoteSavedByDisplayName(oid)}
                      </option>
                    ))}
                  </select>
                  <p className="muted vendors-page__owner-hint">
                    Vendors are stored per Sales user so they appear on that user’s quotes and SCM
                    PO flows.
                  </p>
                </>
              )}
            </label>
          </div>
        ) : null}

        <div className="vendors-page__create-grid">
          <label className="field vendors-page__create-name">
            <span className="field__label">Vendor name</span>
            <input
              type="text"
              className="field__control"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoComplete="organization"
            />
          </label>
        </div>

        <div className="vendors-page__create-addresses">
          <p className="vendors-page__create-addresses-title">Addresses</p>
          <ul className="vendors-page__create-addr-list">
            {newAddresses.map((a, index) => (
              <li key={a.id} className="vendors-page__create-addr-block">
                <div className="vendors-page__create-addr-head">
                  <span className="vendors-page__create-addr-slot">Address {index + 1}</span>
                  {newAddresses.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn--compact vendors-page__create-addr-remove"
                      onClick={() => removeNewAddressRow(a.id)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <label className="field vendors-page__create-lines">
                  <span className="field__label">Address (multi-line)</span>
                  <textarea
                    className="field__control"
                    rows={4}
                    value={a.lines}
                    onChange={(e) => patchNewAddress(a.id, { lines: e.target.value })}
                  />
                </label>
              </li>
            ))}
          </ul>
          <div className="vendors-page__create-add-row">
            <button
              type="button"
              className="btn btn-ghost vendors-page__add-address-btn"
              onClick={addNewAddressRow}
              title="Add another address"
            >
              <span className="vendors-page__add-address-icon" aria-hidden>
                <IconPlus />
              </span>
              <span>Add another address</span>
            </button>
          </div>
        </div>

        <div className="vendors-page__new-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCreateVendor}
            disabled={pickOwner && ownerOptions.length === 0}
          >
            Save vendor
          </button>
          <Link to={listPath} className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </div>
    </section>
  )
}
