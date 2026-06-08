import type { VendorAddress, VendorEntry } from '../types/vendor'

// Bump storage version to start fresh (ignore old test data in localStorage).
const STORAGE_KEY = 'scm_workflow_vendors_v2'

type StoredRow = VendorEntry & { savedBy: string }

function readAll(): StoredRow[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (r): r is StoredRow =>
        r &&
        typeof r === 'object' &&
        typeof (r as StoredRow).id === 'string' &&
        typeof (r as StoredRow).savedBy === 'string' &&
        typeof (r as StoredRow).name === 'string' &&
        Array.isArray((r as StoredRow).addresses),
    )
  } catch {
    return []
  }
}

function writeAll(rows: StoredRow[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    /* quota */
  }
}

export function listVendorsForUser(savedBy: string): VendorEntry[] {
  return readAll()
    .filter((r) => r.savedBy === savedBy)
    .map(({ savedBy: _s, ...v }) => v)
}

/** All vendor rows (for SCM / Finance read-only directory). */
export function listVendorDirectoryRows(): Array<{
  vendor: VendorEntry
  directoryOwnerOid: string
}> {
  return readAll().map(({ savedBy, ...v }) => ({
    vendor: v,
    directoryOwnerOid: savedBy,
  }))
}

export function getVendorForUser(
  vendorId: string,
  savedBy: string,
): VendorEntry | undefined {
  const r = readAll().find((x) => x.id === vendorId && x.savedBy === savedBy)
  if (!r) return undefined
  const { savedBy: _s, ...v } = r
  return v
}

/**
 * Find a vendor directory row by id across all Sales owners (same browser).
 * Used when SCM lists OVFs: `getVendorForUser` is preferred, but this recovers
 * display if the row exists under a different `savedBy` or legacy data drifted.
 */
export function getVendorByIdGlobally(vendorId: string): VendorEntry | undefined {
  const id = vendorId.trim()
  if (!id) return undefined
  const r = readAll().find((x) => x.id === id)
  if (!r) return undefined
  const { savedBy: _s, ...v } = r
  return v
}

function newId(): string {
  return crypto.randomUUID()
}

export function createVendorForUser(
  savedBy: string,
  name: string,
  addressRows: { label: string; lines: string }[],
): VendorEntry {
  const addrObjs: VendorAddress[] = addressRows
    .map((a) => ({
      label: a.label.trim(),
      lines: a.lines.trim(),
    }))
    .filter((a) => a.lines.length > 0)
    .map((a) => ({
      id: newId(),
      label: a.label,
      lines: a.lines,
    }))

  if (addrObjs.length === 0) {
    throw new Error('createVendorForUser requires at least one address with non-empty lines')
  }

  const entry: StoredRow = {
    id: newId(),
    name: name.trim(),
    addresses: addrObjs,
    updatedAt: new Date().toISOString(),
    savedBy,
  }
  const all = readAll()
  all.unshift(entry)
  writeAll(all)
  const { savedBy: _s, ...v } = entry
  return v
}

export function updateVendorForUser(savedBy: string, vendor: VendorEntry): boolean {
  const all = readAll()
  const i = all.findIndex((r) => r.id === vendor.id && r.savedBy === savedBy)
  if (i === -1) return false
  const next: StoredRow = {
    ...vendor,
    savedBy,
    updatedAt: new Date().toISOString(),
  }
  all[i] = next
  writeAll(all)
  return true
}

export function deleteVendorForUser(vendorId: string, savedBy: string): boolean {
  const all = readAll()
  const next = all.filter((r) => !(r.id === vendorId && r.savedBy === savedBy))
  if (next.length === all.length) return false
  writeAll(next)
  return true
}
