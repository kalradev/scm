import type { ScmPoStoredState } from '../types/scmPo'
import { getScmGrmListLabel, type ScmGrmListTone } from './scmGrmUtils'
import { isQuoteDraft, type SavedQuoteRecord } from './savedQuotesStorage'
import {
  computeLineSubtotalInr,
  computeLineTaxAmountInr,
  normalizeScmPoLineTaxPct,
} from './scmPoLine'

/** Same grand-total logic as the PO editor / PDF (subtotal + GST lines + distribution). */
export function computeScmPoDealTotals(form: ScmPoStoredState): {
  subtotalInr: number
  gstTotalInr: number
  distributionInr: number
  grandInr: number
} {
  let subtotalInr = 0
  let gstTotalInr = 0
  for (const l of form.lines) {
    const qty = String(l.quantity ?? '').trim()
    const rate = String(l.rate ?? '').trim()
    if (!qty && !rate) continue
    subtotalInr += computeLineSubtotalInr(qty, rate)
    gstTotalInr += computeLineTaxAmountInr(qty, rate, normalizeScmPoLineTaxPct(l.tax))
  }
  const distributionInr = computeDistributionChargesInrLike(form, subtotalInr)
  const grandInr = subtotalInr + gstTotalInr + distributionInr
  return { subtotalInr, gstTotalInr, distributionInr, grandInr }
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function computeDistributionChargesInrLike(form: ScmPoStoredState, subtotalInr: number): number {
  void subtotalInr
  return form.lines.reduce((sum, line) => {
    const pct = parseMoney(String(line.distributionPct ?? '').trim())
    if (!Number.isFinite(pct) || pct <= 0) return sum
    const sub = computeLineSubtotalInr(
      String(line.quantity ?? '').trim(),
      String(line.rate ?? '').trim(),
    )
    if (sub <= 0) return sum
    return sum + (sub * pct) / 100
  }, 0)
}

export type VendorPoReceiptFilterKey = 'pending' | 'partial' | 'closed' | 'nolines'

export type VendorPoDealRow = {
  quoteId: string
  poRef: string
  companyPoNumber: string
  ovfRef: string
  quoteRef: string
  vendorDirectoryId: string
  vendorName: string
  customerName: string
  /** Document status (not shown in the Vendors &amp; PO list — use GRN fields for the main badge). */
  status: ScmPoStoredState['status']
  grandInr: number
  createdAt?: string
  updatedAt?: string
  /** Quote record timestamp when SCM dates are missing. */
  quoteSavedAt: string
  purchaseDate: string
  /** GRN: receipt / delivery; same logic as the Purchase orders page. */
  grmLabel: string
  grmTone: ScmGrmListTone
  grmFilterKey: VendorPoReceiptFilterKey
}

export type VendorDealAggregate = {
  vendorDirectoryId: string
  vendorName: string
  poCount: number
  draftCount: number
  finalCount: number
  /** Sum of PO grand totals (draft + final). */
  totalDealInr: number
}

function vendorPoDealRowTimestamp(row: Pick<VendorPoDealRow, 'updatedAt' | 'createdAt' | 'quoteSavedAt'>): number {
  return Math.max(
    Date.parse(String(row.updatedAt || '')) || 0,
    Date.parse(String(row.createdAt || '')) || 0,
    Date.parse(String(row.quoteSavedAt || '')) || 0,
  )
}

function toVendorPoDealRow(r: SavedQuoteRecord & { scmPo: NonNullable<SavedQuoteRecord['scmPo']> }): VendorPoDealRow {
  const p = r.scmPo
  const totals = computeScmPoDealTotals(p)
  const grm = getScmGrmListLabel(p.lines, r.scmGrm)
  return {
    quoteId: r.id,
    poRef: (p.poRef || '').trim() || '—',
    companyPoNumber: (p.companyPoNumber || '').trim() || '—',
    ovfRef: (r.ovf?.ovfRef || '').trim() || '—',
    quoteRef: (r.quoteRef || '').trim() || '—',
    vendorDirectoryId: (p.vendorDirectoryId || '').trim(),
    vendorName: (p.vendorNameSnapshot || '').trim() || '—',
    customerName: (p.customerName || '').trim() || '—',
    status: p.status,
    grmLabel: grm.label,
    grmTone: grm.tone,
    grmFilterKey: grm.filterKey,
    grandInr: totals.grandInr,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    quoteSavedAt: r.savedAt,
    purchaseDate: (p.purchaseDate || '').trim(),
  }
}

/**
 * PO history for the same quote-owner scope as vendors (`savedBy`).
 * Sorted newest first by `scmPo.updatedAt ?? scmPo.createdAt ?? savedAt`.
 */
export function buildVendorPoTracking(rows: SavedQuoteRecord[], quoteOwnerOid: string): {
  vendorAggregates: VendorDealAggregate[]
  detailRows: VendorPoDealRow[]
} {
  const scoped = rows.filter(
    (r): r is SavedQuoteRecord & { scmPo: NonNullable<SavedQuoteRecord['scmPo']> } =>
      r.savedBy === quoteOwnerOid && !isQuoteDraft(r) && Boolean(r.scmPo),
  )

  const detailRows: VendorPoDealRow[] = scoped.map((r) => toVendorPoDealRow(r))

  detailRows.sort((a, b) => vendorPoDealRowTimestamp(b) - vendorPoDealRowTimestamp(a))

  const aggMap = new Map<string, VendorDealAggregate>()
  for (const row of detailRows) {
    const vid = row.vendorDirectoryId || '_unknown'
    const prev = aggMap.get(vid)
    const name = row.vendorName && row.vendorName !== '—' ? row.vendorName : row.vendorDirectoryId || 'Unknown vendor'
    if (!prev) {
      aggMap.set(vid, {
        vendorDirectoryId: vid === '_unknown' ? '' : vid,
        vendorName: name,
        poCount: 1,
        draftCount: row.status === 'draft' ? 1 : 0,
        finalCount: row.status === 'final' ? 1 : 0,
        totalDealInr: row.grandInr,
      })
    } else {
      prev.poCount += 1
      if (row.status === 'draft') prev.draftCount += 1
      if (row.status === 'final') prev.finalCount += 1
      prev.totalDealInr += row.grandInr
      if (row.vendorName && row.vendorName !== '—') prev.vendorName = row.vendorName
    }
  }

  const vendorAggregates = [...aggMap.values()].sort((a, b) => b.totalDealInr - a.totalDealInr)

  return { vendorAggregates, detailRows }
}

/**
 * Flat list for the Vendors & PO page: sort by vendor (A–Z), then newest first within each vendor.
 */
export function listVendorPoPageRows(records: SavedQuoteRecord[]): VendorPoDealRow[] {
  const withPo = records.filter(
    (r): r is SavedQuoteRecord & { scmPo: NonNullable<SavedQuoteRecord['scmPo']> } =>
      !isQuoteDraft(r) && Boolean(r.scmPo),
  )
  const detailRows: VendorPoDealRow[] = withPo.map((r) => toVendorPoDealRow(r))
  detailRows.sort((a, b) => {
    const labelA = (a.vendorName && a.vendorName !== '—' ? a.vendorName : a.vendorDirectoryId) || '—'
    const labelB = (b.vendorName && b.vendorName !== '—' ? b.vendorName : b.vendorDirectoryId) || '—'
    const vcmp = labelA.localeCompare(labelB, undefined, { sensitivity: 'base' })
    if (vcmp !== 0) return vcmp
    return vendorPoDealRowTimestamp(b) - vendorPoDealRowTimestamp(a)
  })
  return detailRows
}
