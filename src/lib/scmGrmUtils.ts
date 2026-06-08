import type { ScmPoLine } from '../types/scmPo'
import type { ScmGrmLineStatus, ScmGrmState } from '../types/scmGrm'

const T = (s: string) => s.trim()

/** Line rows that represent real PO items (skip blank spacers). */
export function scmGrmRelevantLines(lines: ScmPoLine[]): ScmPoLine[] {
  return lines.filter(
    (l) =>
      T(l.partNumber) || T(l.itemDetails) || T(l.quantity) || T(l.rate),
  )
}

function parseNumberLoose(raw: string): number {
  const t = T(String(raw)).replace(/,/g, '')
  if (!t) return 0
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? n : 0
}

/** Order qty for GRN (from PO line). Blank / invalid → 1. */
export function parseGrmOrderQty(line: ScmPoLine): number {
  const n = parseNumberLoose(line.quantity ?? '')
  if (n > 0) return n
  return 1
}

export function parseGrmReceivedFromString(raw: string, orderQty: number): number {
  return clampGrmReceived(parseNumberLoose(raw), orderQty)
}

export function clampGrmReceived(n: number, orderQty: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (!Number.isFinite(orderQty) || orderQty <= 0) return n < 0 ? 0 : n
  return Math.min(n, orderQty)
}

export function formatGrmQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9) {
    return String(Math.round(n))
  }
  return String(n)
}

/**
 * Parses the "this receipt" session value: how many units are being recorded for this GRN.
 * Capped to what is still allowed (order qty minus already on record).
 */
export function parseGrmSessionDeltaString(
  raw: string,
  orderQty: number,
  alreadyReceived: number,
): number {
  const t = T(String(raw)).replace(/,/g, '')
  const n = t ? Number.parseFloat(t) : 0
  if (!Number.isFinite(n) || n < 0) return 0
  if (!Number.isFinite(orderQty) || orderQty <= 0) return 0
  const b = Math.max(0, Math.min(orderQty, alreadyReceived))
  const maxS = Math.max(0, orderQty - b)
  return Math.min(n, maxS)
}

/**
 * Keeps the "this receipt" input from acting like a string: typing after a literal "0" should not
 * yield "10" or "01". Empty means zero; whole-string zeros collapse to empty.
 * Decimal part is not stripped (e.g. "0.5" is kept as-is for typing).
 */
export function normalizeGrmSessionKeypadString(raw: string): string {
  const t = T(String(raw)).replace(/,/g, '')
  if (!t) return ''
  // Decimals: keep "0.5" / "0." while typing; must run before integer-only "0" → "".
  if (t.includes('.')) return t
  if (/^0+$/.test(t)) return ''
  return t.replace(/^0+/, '') || ''
}

/**
 * After `normalizeGrmSessionKeypadString`, applies the per-GRN max (order − on record) so
 * string concatenation cannot show impossible values (e.g. "2" + "3" when max is 3 → "3" not "23").
 */
export function clampGrmSessionInputDisplay(
  afterNormalize: string,
  orderQty: number,
  alreadyReceived: number,
): string {
  const t = T(afterNormalize).replace(/,/g, '')
  if (!t) return ''
  if (!Number.isFinite(orderQty) || orderQty <= 0) return ''
  const b = Math.max(0, Math.min(orderQty, alreadyReceived))
  const maxS = Math.max(0, orderQty - b)

  if (t.includes('.')) {
    if (t.endsWith('.')) {
      const intStr = t.slice(0, -1)
      if (intStr === '' || intStr === '-') return t
      const p = Number.parseFloat(intStr)
      if (!Number.isFinite(p) || p < 0) return ''
      if (p > maxS) {
        return maxS === 0 ? '' : formatGrmQty(maxS)
      }
      return t
    }
  }

  const n = parseGrmSessionDeltaString(t, orderQty, alreadyReceived)
  if (n === 0) return ''
  return formatGrmQty(n)
}

export function deriveStatusFromReceivedAndOrder(
  received: number,
  order: number,
): ScmGrmLineStatus {
  if (received <= 0) return 'pending'
  if (received >= order) return 'delivered'
  return 'partial'
}

export function mergeScmGrmWithLines(
  lines: ScmPoLine[],
  existing: ScmGrmState | undefined,
): { lineStatusById: Record<string, ScmGrmLineStatus>; quantityReceivedById: Record<string, string> } {
  const byId: Record<string, ScmGrmLineStatus> = { ...existing?.lineStatusById }
  const qBy: Record<string, string> = { ...existing?.quantityReceivedById }

  for (const l of lines) {
    if (byId[l.id] == null) {
      byId[l.id] = 'pending'
    }
  }

  for (const l of lines) {
    const order = parseGrmOrderQty(l)
    if (qBy[l.id] == null) {
      const st = byId[l.id] ?? 'pending'
      if (st === 'delivered') {
        qBy[l.id] = formatGrmQty(order)
      } else {
        qBy[l.id] = '0'
      }
    }
  }

  for (const l of lines) {
    const order = parseGrmOrderQty(l)
    const recv = parseGrmReceivedFromString(qBy[l.id] ?? '0', order)
    qBy[l.id] = formatGrmQty(recv)
    byId[l.id] = deriveStatusFromReceivedAndOrder(recv, order)
  }

  const ids = new Set(lines.map((l) => l.id))
  for (const k of Object.keys(byId)) {
    if (!ids.has(k)) delete byId[k]
  }
  for (const k of Object.keys(qBy)) {
    if (!ids.has(k)) delete qBy[k]
  }

  return { lineStatusById: byId, quantityReceivedById: qBy }
}

export type ScmGrmProgress = {
  total: number
  pending: number
  partial: number
  delivered: number
  isComplete: boolean
}

export function getScmGrmProgress(
  lines: ScmPoLine[],
  grm: ScmGrmState | undefined,
): ScmGrmProgress {
  const rel = scmGrmRelevantLines(lines)
  const merged = mergeScmGrmWithLines(rel, grm)
  let pending = 0
  let partial = 0
  let delivered = 0
  for (const l of rel) {
    const order = parseGrmOrderQty(l)
    const recv = parseGrmReceivedFromString(merged.quantityReceivedById[l.id] ?? '0', order)
    if (recv <= 0) pending += 1
    else if (recv >= order) delivered += 1
    else partial += 1
  }
  const n = rel.length
  return {
    total: n,
    pending,
    partial,
    delivered,
    isComplete: n > 0 && delivered === n,
  }
}

export type ScmGrmListTone = 'pending' | 'partial' | 'closed' | 'muted'

/**
 * Single status for Purchase orders: driven only by GRN. New POs = Pending; updates when SCM saves GRN.
 * No PO lines: em dash (nothing to receive).
 */
export function getScmGrmListLabel(
  lines: ScmPoLine[],
  grm: ScmGrmState | undefined,
): {
  label: string
  tone: ScmGrmListTone
  filterKey: 'pending' | 'partial' | 'closed' | 'nolines'
} {
  const rel = scmGrmRelevantLines(lines)
  if (rel.length === 0) {
    return { label: '—', tone: 'muted', filterKey: 'nolines' }
  }
  if (!grm) {
    return { label: 'Pending', tone: 'pending', filterKey: 'pending' }
  }
  const p = getScmGrmProgress(lines, grm)
  if (p.isComplete) {
    return { label: 'PO closed', tone: 'closed', filterKey: 'closed' }
  }
  if (p.delivered > 0 || p.partial > 0) {
    return { label: 'Partial', tone: 'partial', filterKey: 'partial' }
  }
  return { label: 'Pending', tone: 'pending', filterKey: 'pending' }
}

export type MergedGrmMaps = ReturnType<typeof mergeScmGrmWithLines>

export function isLineGrmFullyReceived(
  line: ScmPoLine,
  merged: MergedGrmMaps,
): boolean {
  const order = parseGrmOrderQty(line)
  const recv = parseGrmReceivedFromString(merged.quantityReceivedById[line.id] ?? '0', order)
  return recv >= order
}

export function isLineGrmOpenForReceipt(line: ScmPoLine, merged: MergedGrmMaps): boolean {
  return !isLineGrmFullyReceived(line, merged)
}

/** Any quantity received (for “Received only” view). */
export function isLineGrmHasReceipt(line: ScmPoLine, merged: MergedGrmMaps): boolean {
  const order = parseGrmOrderQty(line)
  const recv = parseGrmReceivedFromString(merged.quantityReceivedById[line.id] ?? '0', order)
  return recv > 0
}

/**
 * @deprecated GRN uses ordered vs Qty received in the UI; kept for HMR/legacy import compatibility.
 */
export const GRN_STATUS_OPTIONS: { value: ScmGrmLineStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'partial', label: 'Partial' },
  { value: 'delivered', label: 'Delivered' },
]
