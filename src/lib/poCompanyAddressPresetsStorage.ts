import {
  COMPANY_ADDRESS_PRESET_CUSTOM,
  COMPANY_DELIVERY_LOCATIONS,
  getCompanyLocationById,
} from './companyLocations'

const STORAGE_KEY = 'scm_workflow_po_company_address_presets_v2'

export type PoCompanyAddressPreset = {
  id: string
  label: string
  address: string
  createdAt: string
}

function normalizeBlock(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function newId(): string {
  return `po-addr-preset-${crypto.randomUUID()}`
}

function readAll(): PoCompanyAddressPreset[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (r): r is PoCompanyAddressPreset =>
        r &&
        typeof r === 'object' &&
        typeof (r as PoCompanyAddressPreset).id === 'string' &&
        typeof (r as PoCompanyAddressPreset).label === 'string' &&
        typeof (r as PoCompanyAddressPreset).address === 'string' &&
        typeof (r as PoCompanyAddressPreset).createdAt === 'string',
    )
  } catch {
    return []
  }
}

function writeAll(rows: PoCompanyAddressPreset[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    /* quota */
  }
}

export function listPoCompanyAddressPresets(): PoCompanyAddressPreset[] {
  return readAll()
}

/**
 * New preset saved in this browser for everyone using the app here (localStorage, shared in profile).
 * Returns the row, or `null` if label/address are empty.
 */
export function addPoCompanyAddressPreset(
  label: string,
  address: string,
): PoCompanyAddressPreset | null {
  const lab = String(label ?? '').trim()
  const addr = String(address ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
  if (!lab || !addr) return null
  const row: PoCompanyAddressPreset = {
    id: newId(),
    label: lab,
    address: addr,
    createdAt: new Date().toISOString(),
  }
  const next = [row, ...readAll()]
  writeAll(next)
  return row
}

/** Resolves OVF/PO text to a built-in location id, a saved custom id, or `custom` if unknown. */
export function resolveAddressPresetId(
  stored: string | undefined | null,
  customPresets: readonly PoCompanyAddressPreset[],
): string {
  const t = normalizeBlock(stored)
  if (!t) return COMPANY_ADDRESS_PRESET_CUSTOM
  for (const l of COMPANY_DELIVERY_LOCATIONS) {
    if (normalizeBlock(l.address) === t) return l.id
  }
  for (const c of customPresets) {
    if (normalizeBlock(c.address) === t) return c.id
  }
  return COMPANY_ADDRESS_PRESET_CUSTOM
}

export function getAddressTextForCompanyPresetId(
  id: string,
  customPresets: readonly PoCompanyAddressPreset[],
): string | undefined {
  if (!id) return undefined
  const a = getCompanyLocationById(id)
  if (a) return a.address
  return customPresets.find((c) => c.id === id)?.address
}

export function labelForAddressPresetId(
  id: string,
  customPresets: readonly PoCompanyAddressPreset[],
): string | undefined {
  if (!id || id === COMPANY_ADDRESS_PRESET_CUSTOM) return undefined
  const a = getCompanyLocationById(id)
  if (a) return a.label
  return customPresets.find((c) => c.id === id)?.label
}
