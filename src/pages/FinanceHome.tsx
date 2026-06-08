import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { filterCommercialLines } from '../lib/quoteLineItems'
import {
  computeOvfAggregateEconomics,
  getOvfMarginDisplayStrings,
  hasAnyVendorPurchase,
  normalizeVendorPurchaseMap,
} from '../lib/ovfVendorEconomics'
import { extraChargeInrFromField } from '../lib/ovfExtraCharges'
import { mergeOvfForAutosave } from '../lib/ovfWorkflow'
import {
  computeQuoteFinanceReviewExtras,
  enrichQuoteFormWithVendorAttachment,
} from '../lib/enrichQuoteVendorRates'
import {
  quoteFinanceEconomics,
  type QuoteFinanceEconomicsResult,
} from '../lib/quoteFinanceEconomics'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { effectivePoFinanceStatus, effectiveQuoteFinanceStatus } from '../lib/quotePipeline'
import { effectiveOvfWorkflow } from '../lib/ovfWorkflow'
import {
  FINANCE_PO_FINALIZED_NOTICE_KEY,
  QUOTE_FINANCE_HANDOFF_REF_KEY,
} from '../lib/quoteInvoiceSeed'
import {
  listCustomerPoPendingFinanceReview,
  listOvfFinanceApprovedForScm,
  listOvfFinanceRejected,
  listOvfPendingFinanceApproval,
  listQuotesFinanceApprovedForCustomer,
  listQuotesFinanceRejectedForCustomer,
  listQuotesPendingFinanceReview,
  mergePoFinanceReviewOnRecord,
  mergeQuoteFinanceReviewOnRecord,
  resolveQuoteSavedByDisplayName,
  SAVED_QUOTES_LOCAL_STORAGE_KEY,
  updateSavedQuoteFormSnapshotByRecordId,
  updateSavedQuoteOvfByRecordId,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import type { QuoteFormData } from '../types/quotePdf'

/**
 * Finance queue inbox = rows that still need a Finance approve/reject on vendor invoice,
 * customer PO, or OVF. Once an OVF exists, keep the quote here until Finance approves or rejects
 * that OVF (not only while vendor invoice / PO steps are open).
 */
function financeUnifiedRowNeedsInbox(row: SavedQuoteRecord): boolean {
  if (row.ovf) {
    const w = effectiveOvfWorkflow(row.ovf)
    // Terminal OVF outcomes — listed under Approved / Rejected OVF, not this inbox.
    if (w === 'finance_approved' || w === 'finance_rejected') return false
    // OVF submitted or still in Sales draft: quote stays until Finance decides the OVF.
    if (w === 'pending_finance' || w === 'sales_draft') return true
  }
  if (effectiveQuoteFinanceStatus(row) === 'pending_finance') return true
  if (effectivePoFinanceStatus(row) === 'pending_finance') return true
  return false
}

const FINANCE_RECENT_DECISION_MS = 6 * 60 * 60 * 1000

function quoteFinanceRecentlyDecided(row: SavedQuoteRecord): boolean {
  const q = row.quoteFinanceReview
  if (!q) return false
  if (q.workflowStatus === 'pending_finance') return false
  // Once OVF is finance-approved, keep it only in "Approved by Finance" section.
  if (row.ovf && effectiveOvfWorkflow(row.ovf) === 'finance_approved') return false
  const ts = q.financeDecisionAt?.trim()
  if (!ts) return false
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= FINANCE_RECENT_DECISION_MS
}

function poFinanceStageLabel(row: SavedQuoteRecord): string {
  const ps = effectivePoFinanceStatus(row)
  if (ps === 'pending_finance') return 'Awaiting GST check'
  if (ps === 'finance_approved') return 'Approved'
  if (ps === 'finance_rejected') return 'Rejected'
  if (row.po) return 'Not submitted to Finance'
  return 'No customer PO yet'
}

function parseMoneyInr(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMarginPercent(raw: string): number | null {
  const t = String(raw ?? '')
    .trim()
    .replace(/%$/, '')
  const n = Number.parseFloat(t.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Gross vendor spend from quote line rates. Net payable, deposit, and margin basis are on workflow Details. */
function FinancePurchaseTableCell({ econ }: { econ: QuoteFinanceEconomicsResult }) {
  if (!econ.hasVendorCosts) return '—'
  const gross =
    econ.linePurchaseTotal > 0.005 ? econ.linePurchaseTotal : econ.purchaseTotal
  return (
    <span title="Sum of qty × vendor unit on quote lines (gross). Open Details for net payable, deposit, and margin basis.">
      {formatInr(gross)}
    </span>
  )
}

type FinancePendingRowMetrics = {
  row: SavedQuoteRecord
  ovfRef: string
  margins: { margin: string; marginPercent: string }
  owner: string
  marginInr: number
  totalSellInr: number
  totalPurchaseInr: number
  marginPctNumeric: number | null
  submittedAt?: string
}

function byFinanceDecisionDesc(a: SavedQuoteRecord, b: SavedQuoteRecord): number {
  const ta = a.ovf?.financeDecisionAt ?? ''
  const tb = b.ovf?.financeDecisionAt ?? ''
  return tb.localeCompare(ta)
}

function computeFinancePendingRowMetrics(
  row: SavedQuoteRecord,
): FinancePendingRowMetrics | null {
  const ovf = row.ovf
  if (!ovf) return null
  const mod = ovf.fields.ovfModuleOwner?.trim()
  const owner =
    mod || row.savedByDisplayName?.trim() || '—'

  const form = normalizeQuoteFormData(
    row.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(form.lineItems)
  const vendorMap = normalizeVendorPurchaseMap(ovf.fields)
  const agg = computeOvfAggregateEconomics(commercial, vendorMap)
  const freightInr = extraChargeInrFromField(
    ovf.fields.freightCharges,
    ovf.fields.freightChargesUnit,
    agg.totalPurchase,
  )
  const financeInr = extraChargeInrFromField(
    ovf.fields.financeCost,
    ovf.fields.financeCostUnit,
    agg.totalPurchase,
  )
  const vendorExtrasInr = freightInr + financeInr
  const margins = getOvfMarginDisplayStrings(ovf.fields, commercial, agg, vendorExtrasInr)
  const hasVp = hasAnyVendorPurchase(commercial, vendorMap)
  const totalPurchaseInr = agg.totalPurchase + vendorExtrasInr
  const marginInr = hasVp ? agg.totalSell - totalPurchaseInr : parseMoneyInr(ovf.fields.margin)
  const marginPctNumeric = hasVp ? (agg.totalSell > 0 ? (marginInr / agg.totalSell) * 100 : null) : parseMarginPercent(ovf.fields.marginPercent)

  return {
    row,
    ovfRef: ovf.ovfRef,
    margins,
    owner,
    marginInr,
    totalSellInr: agg.totalSell,
    totalPurchaseInr,
    marginPctNumeric,
    submittedAt: ovf.submittedToFinanceAt,
  }
}

function ovfFinancePending(row: SavedQuoteRecord): boolean {
  return Boolean(
    row.ovf && effectiveOvfWorkflow(row.ovf) === 'pending_finance',
  )
}

type UnifiedRowEconomics = {
  sell: number
  purchaseDisplay: number
  marginInr: number
  marginPct: number | null
  quoteEcon: QuoteFinanceEconomicsResult | null
  source: 'ovf' | 'quote'
}

function getUnifiedRowEconomics(row: SavedQuoteRecord): UnifiedRowEconomics {
  const form = normalizeQuoteFormData(
    row.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const quoteEcon = quoteFinanceEconomics(form, row.quoteFinanceReview)
  if (ovfFinancePending(row)) {
    const m = computeFinancePendingRowMetrics(row)
    if (m) {
      return {
        sell: m.totalSellInr,
        purchaseDisplay: m.totalPurchaseInr,
        marginInr: m.marginInr,
        marginPct: m.marginPctNumeric,
        quoteEcon: null,
        source: 'ovf',
      }
    }
  }
  return {
    sell: quoteEcon.sellTotal,
    purchaseDisplay:
      quoteEcon.linePurchaseTotal > 0.005
        ? quoteEcon.linePurchaseTotal
        : quoteEcon.purchaseTotal,
    marginInr: quoteEcon.marginInr,
    marginPct: quoteEcon.marginPct,
    quoteEcon,
    source: 'quote',
  }
}

function unifiedFinanceOwner(row: SavedQuoteRecord): string {
  if (ovfFinancePending(row)) {
    const m = computeFinancePendingRowMetrics(row)
    if (m) return m.owner
  }
  return (
    (row.savedByDisplayName ?? '').trim() ||
    resolveQuoteSavedByDisplayName(row.savedBy)
  )
}

function financeUnifiedSortRank(row: SavedQuoteRecord): number {
  if (ovfFinancePending(row)) return 0
  if (effectivePoFinanceStatus(row) === 'pending_finance') return 1
  if (row.quoteFinanceReview?.workflowStatus === 'pending_finance') return 2
  return 3
}

function financeUnifiedSortTs(row: SavedQuoteRecord): string {
  if (ovfFinancePending(row)) return row.ovf?.submittedToFinanceAt ?? ''
  if (effectivePoFinanceStatus(row) === 'pending_finance') {
    return row.poFinanceReview?.submittedToFinanceAt ?? ''
  }
  if (row.quoteFinanceReview?.workflowStatus === 'pending_finance') {
    return row.quoteFinanceReview.submittedToFinanceAt ?? ''
  }
  return row.savedAt
}

function FinanceKpiIcon({ name }: { name: 'queue' | 'margin' | 'pct' | 'sell' }) {
  const p = {
    className: 'finance-home__kpi-icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'queue':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.008v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.008v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.008v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
          />
        </svg>
      )
    case 'margin':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 18L9 11.25l4.5 4.5L21.75 7.5M21.75 7.5h-6.75M21.75 7.5v6.75"
          />
        </svg>
      )
    case 'pct':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V9.75L10.5 1.5zM9 9.75h6M9 13.5h6M9 17.25h4.5"
          />
        </svg>
      )
    case 'sell':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v12m6-6H6M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )
    default:
      return null
  }
}

export function FinanceHome() {
  const { user } = useAuth()
  const [version, setVersion] = useState(0)
  const [rejectFor, setRejectFor] = useState<SavedQuoteRecord | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [rejectQuoteFinanceFor, setRejectQuoteFinanceFor] =
    useState<SavedQuoteRecord | null>(null)
  const [rejectQuoteFinanceNote, setRejectQuoteFinanceNote] = useState('')
  const [rejectPoFinanceFor, setRejectPoFinanceFor] =
    useState<SavedQuoteRecord | null>(null)
  const [rejectPoFinanceNote, setRejectPoFinanceNote] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [quoteHandoffBanner, setQuoteHandoffBanner] = useState<string | null>(
    null,
  )
  const [poFinalizedBanner, setPoFinalizedBanner] = useState<string | null>(null)

  useEffect(() => {
    try {
      const ref = sessionStorage.getItem(QUOTE_FINANCE_HANDOFF_REF_KEY)?.trim()
      if (ref) {
        sessionStorage.removeItem(QUOTE_FINANCE_HANDOFF_REF_KEY)
        setQuoteHandoffBanner(
          `Quote ${ref} was just submitted for review. It should appear in the Finance queue below shortly.`,
        )
      }
      const poMsg = sessionStorage.getItem(FINANCE_PO_FINALIZED_NOTICE_KEY)?.trim()
      if (poMsg) {
        sessionStorage.removeItem(FINANCE_PO_FINALIZED_NOTICE_KEY)
        setPoFinalizedBanner(poMsg)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const quotesPendingReview = useMemo(() => {
    void version
    return listQuotesPendingFinanceReview()
  }, [version])

  const quotesRecentlyDecided = useMemo(() => {
    void version
    const decided = [
      ...listQuotesFinanceApprovedForCustomer(),
      ...listQuotesFinanceRejectedForCustomer(),
    ]
      .filter(quoteFinanceRecentlyDecided)
      .sort((a, b) =>
        (b.quoteFinanceReview?.financeDecisionAt ?? '').localeCompare(
          a.quoteFinanceReview?.financeDecisionAt ?? '',
        ),
      )
    return decided.slice(0, 20)
  }, [version])

  /**
   * One row per quote: vendor-invoice (quote) stage + customer PO stage, both downloads in-line.
   * PO-pending rows sort first; no duplicate rows across former split sections.
   */
  const invoicePathQuoteAndCustomerPoRows = useMemo(() => {
    void version
    const poPending = listCustomerPoPendingFinanceReview()
    const readyForCustomer = listQuotesFinanceApprovedForCustomer().filter(
      (row) => effectivePoFinanceStatus(row) !== 'pending_finance',
    )
    const seen = new Set(poPending.map((r) => r.id))
    const out: SavedQuoteRecord[] = [...poPending]
    for (const r of readyForCustomer) {
      if (!seen.has(r.id)) out.push(r)
    }
    out.sort((a, b) => {
      const aUrgent = effectivePoFinanceStatus(a) === 'pending_finance' ? 0 : 1
      const bUrgent = effectivePoFinanceStatus(b) === 'pending_finance' ? 0 : 1
      if (aUrgent !== bUrgent) return aUrgent - bUrgent
      const ta = a.poFinanceReview?.submittedToFinanceAt ?? a.savedAt
      const tb = b.poFinanceReview?.submittedToFinanceAt ?? b.savedAt
      return tb.localeCompare(ta)
    })
    return out
  }, [version])

  const pending = useMemo(() => {
    void version
    return listOvfPendingFinanceApproval()
  }, [version])

  const quoteRefsWithApprovedOvf = useMemo(() => {
    void version
    const set = new Set<string>()
    for (const row of listOvfFinanceApprovedForScm()) {
      const refA = (row.quoteRef || '').trim()
      const refB = (row.ovf?.fields.quoteNumber || '').trim()
      if (refA) set.add(refA)
      if (refB) set.add(refB)
    }
    return set
  }, [version])

  /**
   * Single Finance inbox: vendor invoice queue · customer PO · OVF commercials (deduped by quote).
   */
  const unifiedFinanceVendorInvoiceRows = useMemo(() => {
    void version
    const byId = new Map<string, SavedQuoteRecord>()
    const take = (rows: SavedQuoteRecord[]) => {
      for (const r of rows) {
        if (!byId.has(r.id)) byId.set(r.id, r)
      }
    }
    take(quotesPendingReview)
    take(invoicePathQuoteAndCustomerPoRows)
    take(pending)
    // Keep recently decided invoice approvals visible so Finance can confirm what was just handled.
    take(quotesRecentlyDecided)
    const out = [...byId.values()].filter((r) => {
      const ref = (r.quoteRef || '').trim()
      // If any record for this quote has an OVF finance-approved, keep it only in "Approved by Finance".
      if (ref && quoteRefsWithApprovedOvf.has(ref)) return false
      return financeUnifiedRowNeedsInbox(r) || quoteFinanceRecentlyDecided(r)
    })
    out.sort((a, b) => {
      const ra = financeUnifiedSortRank(a)
      const rb = financeUnifiedSortRank(b)
      if (ra !== rb) return ra - rb
      return financeUnifiedSortTs(b).localeCompare(financeUnifiedSortTs(a))
    })
    return out
  }, [
    version,
    quotesPendingReview,
    quotesRecentlyDecided,
    invoicePathQuoteAndCustomerPoRows,
    pending,
    quoteRefsWithApprovedOvf,
  ])

  /**
   * Customer PO column + PO Actions only when any unified row awaits PO (GST) review.
   */
  const showUnifiedCustomerPoColumn = useMemo(() => {
    void version
    return unifiedFinanceVendorInvoiceRows.some(
      (row) => effectivePoFinanceStatus(row) === 'pending_finance',
    )
  }, [unifiedFinanceVendorInvoiceRows, version])

  /** Show OVF ref column only when there is an OVF awaiting Finance decision. */
  const showUnifiedOvfColumn = useMemo(() => {
    return unifiedFinanceVendorInvoiceRows.some(
      (row) => Boolean(row.ovf) && effectiveOvfWorkflow(row.ovf) === 'pending_finance',
    )
  }, [unifiedFinanceVendorInvoiceRows])

  /** Hide Actions once nothing in this inbox needs inline approve/reject (e.g. OVF decided; use Details only). */
  const showFinanceQueueActionsColumn = useMemo(() => {
    return unifiedFinanceVendorInvoiceRows.some((row) => {
      const quoteFinPending =
        row.quoteFinanceReview?.workflowStatus === 'pending_finance'
      const poPending = effectivePoFinanceStatus(row) === 'pending_finance'
      return quoteFinPending || poPending || ovfFinancePending(row)
    })
  }, [unifiedFinanceVendorInvoiceRows])

  /**
   * After Sales submits an OVF to Finance, list owner from OVF module — header reflects that.
   */
  const financeQueueOwnerColumnLabel = useMemo(() => {
    const rows = unifiedFinanceVendorInvoiceRows
    if (rows.length === 0) return 'Sales owner'
    const ovfOnly = rows.filter(ovfFinancePending)
    if (ovfOnly.length === rows.length) return 'OVF owner'
    if (ovfOnly.length > 0) return 'Sales / OVF owner'
    return 'Sales owner'
  }, [unifiedFinanceVendorInvoiceRows])

  const approved = useMemo(() => {
    void version
    return [...listOvfFinanceApprovedForScm()].sort(byFinanceDecisionDesc)
  }, [version])

  const rejected = useMemo(() => {
    void version
    return [...listOvfFinanceRejected()].sort(byFinanceDecisionDesc)
  }, [version])

  const analytics = useMemo(() => {
    const count = unifiedFinanceVendorInvoiceRows.length
    let totalMargin = 0
    let totalSell = 0
    const pcts: number[] = []
    for (const row of unifiedFinanceVendorInvoiceRows) {
      const u = getUnifiedRowEconomics(row)
      totalMargin += u.marginInr
      totalSell += u.sell
      if (u.marginPct != null && Number.isFinite(u.marginPct)) {
        pcts.push(u.marginPct)
      }
    }
    const avgPct =
      pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null
    return { count, totalMargin, totalSell, avgPct }
  }, [unifiedFinanceVendorInvoiceRows])

  const approvedMetrics = useMemo(
    () =>
      approved
        .map((row) => computeFinancePendingRowMetrics(row))
        .filter((m): m is FinancePendingRowMetrics => m != null),
    [approved],
  )

  const approvedTotals = useMemo(() => {
    let totalMargin = 0
    let totalSell = 0
    for (const m of approvedMetrics) {
      totalMargin += m.marginInr
      totalSell += m.totalSellInr
    }
    return {
      count: approvedMetrics.length,
      totalMargin,
      totalSell,
    }
  }, [approvedMetrics])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  /** Sales submits PO from another tab; `storage` fires here so the PO queue updates without a manual refresh. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_QUOTES_LOCAL_STORAGE_KEY) refresh()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [refresh])

  /** Backfill vendor unit rates from the attached invoice file so purchase/margin columns populate. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = listQuotesPendingFinanceReview()
      let changed = false
      for (const row of rows) {
        if (cancelled) break
        const inv = row.quoteFinanceReview?.vendorInvoice
        if (!inv) continue
        const form = normalizeQuoteFormData(
          row.formSnapshot as QuoteFormData & { customerTitle?: string },
        )
        if (quoteFinanceEconomics(form, row.quoteFinanceReview).hasVendorCosts)
          continue
        try {
          const enriched = await enrichQuoteFormWithVendorAttachment(form, inv)
          if (cancelled) break
          const extras = await computeQuoteFinanceReviewExtras(enriched, inv)
          const mergedReview = {
            ...row.quoteFinanceReview,
            ...extras,
          }
          if (
            !quoteFinanceEconomics(enriched, mergedReview).hasVendorCosts
          ) {
            continue
          }
          updateSavedQuoteFormSnapshotByRecordId(row.id, enriched)
          if (Object.keys(extras).length > 0) {
            mergeQuoteFinanceReviewOnRecord(row.id, extras)
          }
          changed = true
        } catch {
          /* ignore */
        }
      }
      if (changed && !cancelled) refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [version, refresh])

  const handleApproveQuoteFinance = useCallback(
    (row: SavedQuoteRecord) => {
      if (!user || !row.quoteFinanceReview) return
      const form = normalizeQuoteFormData(
        row.formSnapshot as QuoteFormData & { customerTitle?: string },
      )
      const econ = quoteFinanceEconomics(form, row.quoteFinanceReview)
      const econNote = econ.hasVendorCosts
        ? `\n\nSell ${formatInr(econ.sellTotal)} · Purchase (est.) ${formatInr(econ.purchaseTotal)} · Margin ${formatInr(econ.marginInr)} (${econ.marginPct != null ? `${econ.marginPct.toFixed(2)}%` : '—'}).`
        : ''
      if (
        !window.confirm(
          `Approve quote ${row.quoteRef} (vendor invoice) so Sales can send it to the customer?${econNote}`,
        )
      ) {
        return
      }
      const now = new Date().toISOString()
      const merged = mergeQuoteFinanceReviewOnRecord(row.id, {
        workflowStatus: 'finance_approved',
        financeApprovedBy: user.displayName?.trim() || user.oid,
        financeApprovedByOid: user.oid,
        financeDecisionAt: now,
        financeRejectionNote: undefined,
      })
      if (!merged) {
        setActionError('Could not approve (quote removed).')
        window.setTimeout(() => setActionError(null), 6000)
        return
      }
      refresh()
    },
    [user, refresh],
  )

  const openRejectQuoteFinance = useCallback((row: SavedQuoteRecord) => {
    setRejectQuoteFinanceNote('')
    setRejectQuoteFinanceFor(row)
  }, [])

  const confirmRejectQuoteFinance = useCallback(() => {
    if (!rejectQuoteFinanceFor?.quoteFinanceReview || !user) return
    const note = rejectQuoteFinanceNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergeQuoteFinanceReviewOnRecord(rejectQuoteFinanceFor.id, {
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setRejectQuoteFinanceFor(null)
    setRejectQuoteFinanceNote('')
    if (!merged) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, rejectQuoteFinanceFor, rejectQuoteFinanceNote, refresh])

  const handleApprovePoFinance = useCallback(
    (row: SavedQuoteRecord) => {
      if (!user) return
      if (effectivePoFinanceStatus(row) !== 'pending_finance') return
      if (
        !window.confirm(
          `Approve customer PO GST check for quote ${row.quoteRef}? Sales can then create the OVF.`,
        )
      ) {
        return
      }
      const now = new Date().toISOString()
      const merged = mergePoFinanceReviewOnRecord(row.id, {
        workflowStatus: 'finance_approved',
        financeApprovedBy: user.displayName?.trim() || user.oid,
        financeApprovedByOid: user.oid,
        financeDecisionAt: now,
        financeRejectionNote: undefined,
      })
      if (!merged) {
        setActionError(
          'Could not save approval — quote may be missing, or browser storage is full / blocked. Free disk space or clear site data for this app, then try again.',
        )
        window.setTimeout(() => setActionError(null), 8000)
        return
      }
      refresh()
    },
    [user, refresh],
  )

  const openRejectPoFinance = useCallback((row: SavedQuoteRecord) => {
    setRejectPoFinanceNote('')
    setRejectPoFinanceFor(row)
  }, [])

  const confirmRejectPoFinance = useCallback(() => {
    if (!rejectPoFinanceFor?.poFinanceReview || !user) return
    const note = rejectPoFinanceNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergePoFinanceReviewOnRecord(rejectPoFinanceFor.id, {
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setRejectPoFinanceFor(null)
    setRejectPoFinanceNote('')
    if (!merged) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, rejectPoFinanceFor, rejectPoFinanceNote, refresh])

  const handleApprove = useCallback(
    (row: SavedQuoteRecord) => {
      if (!user || !row.ovf) return
      if (!window.confirm(`Approve ${row.ovf.ovfRef} for SCM? Sales will no longer edit this OVF.`)) {
        return
      }
      const merged = mergeOvfForAutosave(row.ovf, row.ovf.ovfRef, row.ovf.fields)
      const next = updateSavedQuoteOvfByRecordId(row.id, {
        ...merged,
        workflowStatus: 'finance_approved',
        financeApprovedBy: user.displayName || user.oid,
        financeApprovedByOid: user.oid,
        financeDecisionAt: new Date().toISOString(),
        financeRejectionNote: undefined,
      })
      if (!next) {
        setActionError('Could not save approval (quote may have been removed).')
        window.setTimeout(() => setActionError(null), 6000)
        return
      }
      refresh()
    },
    [user, refresh],
  )

  const openReject = useCallback((row: SavedQuoteRecord) => {
    setRejectNote('')
    setRejectFor(row)
  }, [])

  const confirmReject = useCallback(() => {
    if (!user || !rejectFor?.ovf) return
    const note = rejectNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergeOvfForAutosave(
      rejectFor.ovf,
      rejectFor.ovf.ovfRef,
      rejectFor.ovf.fields,
    )
    const next = updateSavedQuoteOvfByRecordId(rejectFor.id, {
      ...merged,
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setRejectFor(null)
    setRejectNote('')
    if (!next) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, rejectFor, rejectNote, refresh])

  return (
    <section className="panel finance-home">
      <header className="finance-home__hero">
        <div className="finance-home__hero-text">
          <h2 className="finance-home__title">Finance workspace</h2>
        </div>
      </header>

      {actionError ? (
        <p className="finance-home__banner finance-home__banner--err" role="alert">
          {actionError}
        </p>
      ) : null}

      {quoteHandoffBanner ? (
        <div
          className="finance-home__banner finance-home__banner--handoff"
          role="status"
        >
          <span>{quoteHandoffBanner}</span>
          <button
            type="button"
            className="btn btn-ghost btn--compact"
            onClick={() => setQuoteHandoffBanner(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {poFinalizedBanner ? (
        <div
          className="finance-home__banner finance-home__banner--handoff"
          role="status"
        >
          <span>{poFinalizedBanner}</span>
          <button
            type="button"
            className="btn btn-ghost btn--compact"
            onClick={() => setPoFinalizedBanner(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="finance-home__kpi-grid" role="region" aria-label="Queue analytics">
        <div className="finance-home__kpi-card finance-home__kpi-card--queue">
          <span className="finance-home__kpi-icon" aria-hidden>
            <FinanceKpiIcon name="queue" />
          </span>
          <div className="finance-home__kpi-text">
            <span className="finance-home__kpi-value">{analytics.count}</span>
            <span className="finance-home__kpi-label">Pending approval</span>
          </div>
        </div>
        <div className="finance-home__kpi-card finance-home__kpi-card--margin">
          <span className="finance-home__kpi-icon" aria-hidden>
            <FinanceKpiIcon name="margin" />
          </span>
          <div className="finance-home__kpi-text">
            <span className="finance-home__kpi-value">
              {analytics.count ? formatInr(analytics.totalMargin) : '—'}
            </span>
            <span className="finance-home__kpi-label">Combined margin (INR)</span>
          </div>
        </div>
        <div className="finance-home__kpi-card finance-home__kpi-card--pct">
          <span className="finance-home__kpi-icon" aria-hidden>
            <FinanceKpiIcon name="pct" />
          </span>
          <div className="finance-home__kpi-text">
            <span className="finance-home__kpi-value">
              {analytics.avgPct != null ? `${analytics.avgPct.toFixed(2)}%` : '—'}
            </span>
            <span className="finance-home__kpi-label">Avg margin % (queue)</span>
          </div>
        </div>
        <div className="finance-home__kpi-card finance-home__kpi-card--sell">
          <span className="finance-home__kpi-icon" aria-hidden>
            <FinanceKpiIcon name="sell" />
          </span>
          <div className="finance-home__kpi-text">
            <span className="finance-home__kpi-value">
              {analytics.count ? formatInr(analytics.totalSell) : '—'}
            </span>
            <span className="finance-home__kpi-label">Quoted sell total (INR)</span>
          </div>
        </div>
      </div>

      <div className="finance-home__section finance-home__section--quote-po-unified finance-home__section--finance-queue-unified">
        <h3 className="finance-home__section-title">
          Finance queue (vendor invoice · customer PO · OVF)
        </h3>
        <p className="muted finance-home__section-desc finance-home__section-desc--tight">
          One inbox for quote invoice review, customer PO checks, and OVF commercials awaiting your
          decision. Open <strong>Details</strong> for full context.
        </p>
        {unifiedFinanceVendorInvoiceRows.length === 0 ? (
          <p className="muted finance-home__empty">
            Nothing is waiting at these Finance steps right now.
          </p>
        ) : (
          <div className="finance-home__table-wrap finance-home__table-wrap--quote-po-unified">
            <table
              className={`finance-home__table finance-home__table--quote-po-unified finance-home__table--finance-queue-unified${
                showUnifiedCustomerPoColumn
                  ? ''
                  : ' finance-home__table--quote-po-unified--no-customer-po'
              }${showFinanceQueueActionsColumn ? '' : ' finance-home__table--finance-queue-no-actions'}`}
            >
              <thead>
                <tr>
                  <th scope="col" className="finance-home__th--quote-ref">
                    Quote
                  </th>
                  {showUnifiedOvfColumn ? (
                    <th scope="col" className="finance-home__th--ovf-ref">
                      OVF
                    </th>
                  ) : null}
                  <th
                    scope="col"
                    className="finance-home__th--queue-text"
                    title="Quote rows: sales contact. OVF rows (submitted to Finance): OVF module owner."
                  >
                    {financeQueueOwnerColumnLabel}
                  </th>
                  <th scope="col" className="finance-home__th--queue-text">
                    Customer
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Sell
                  </th>
                  <th
                    scope="col"
                    className="finance-home__th--num"
                    title="Quote lines: gross vendor rates. OVF rows: OVF purchase total (see Details)."
                  >
                    Purchase
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Margin
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Margin %
                  </th>
                  {showUnifiedCustomerPoColumn ? (
                    <th scope="col" className="finance-home__th--dual">
                      Customer PO
                    </th>
                  ) : null}
                  <th scope="col" className="finance-home__th--details">
                    Details
                  </th>
                  {showFinanceQueueActionsColumn ? (
                    <th scope="col">Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {unifiedFinanceVendorInvoiceRows.map((row) => {
                  const u = getUnifiedRowEconomics(row)
                  const form = normalizeQuoteFormData(
                    row.formSnapshot as QuoteFormData & { customerTitle?: string },
                  )
                  const po = row.po
                  const poPending = effectivePoFinanceStatus(row) === 'pending_finance'
                  const quoteFinPending =
                    row.quoteFinanceReview?.workflowStatus === 'pending_finance'
                  const showMoney =
                    u.source === 'ovf' ||
                    (u.quoteEcon != null && u.quoteEcon.hasVendorCosts)
                  const cust =
                    (row.ovf?.fields.customerName || form.customerName || '').trim() || '—'
                  return (
                    <tr key={`fin-queue-${row.id}`}>
                      <td className="finance-home__td--quote-ref">{row.quoteRef}</td>
                      {showUnifiedOvfColumn ? (
                        <td className="finance-home__td--ovf-ref">
                          {row.ovf && effectiveOvfWorkflow(row.ovf) === 'pending_finance'
                            ? row.ovf.ovfRef
                            : '—'}
                        </td>
                      ) : null}
                      <td className="finance-home__td--queue-text">{unifiedFinanceOwner(row)}</td>
                      <td className="finance-home__td--queue-text">{cust}</td>
                      <td className="finance-home__td--num">{formatInr(u.sell)}</td>
                      <td
                        className="finance-home__td--num"
                        title={
                          u.source === 'ovf'
                            ? 'OVF vendor purchase total (includes freight/finance as entered).'
                            : u.quoteEcon && !u.quoteEcon.hasVendorCosts
                              ? 'Vendor unit rates were not extracted for these lines. Open Details.'
                              : undefined
                        }
                      >
                        {u.source === 'ovf' ? (
                          formatInr(u.purchaseDisplay)
                        ) : u.quoteEcon ? (
                          <FinancePurchaseTableCell econ={u.quoteEcon} />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        className="finance-home__td--num"
                        title={
                          showMoney
                            ? undefined
                            : 'Vendor unit rates were not extracted for these lines.'
                        }
                      >
                        {showMoney ? formatInr(u.marginInr) : '—'}
                      </td>
                      <td className="finance-home__td--num">
                        {showMoney && u.marginPct != null
                          ? `${u.marginPct.toFixed(2)}%`
                          : '—'}
                      </td>
                      {showUnifiedCustomerPoColumn ? (
                        <td className="finance-home__td--dual">
                          {poPending ? (
                            <div className="finance-home__dual-block">
                              <span className="finance-home__dual-status finance-home__dual-status--pending">
                                {poFinanceStageLabel(row)}
                              </span>
                              {po?.customerPoNumber?.trim() ? (
                                <span className="finance-home__dual-meta muted">
                                  Ref: {po.customerPoNumber.trim()}
                                </span>
                              ) : null}
                              {row.poFinanceReview?.submittedToFinanceAt ? (
                                <span className="finance-home__dual-meta muted">
                                  Submitted{' '}
                                  {new Date(
                                    row.poFinanceReview.submittedToFinanceAt,
                                  ).toLocaleString(undefined, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                  })}
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ) : null}
                      <td className="finance-home__td--details">
                        <Link
                          to={`/finance/q/${row.id}/workflow`}
                          className="btn btn-ghost btn--compact"
                          aria-label="Open quote workflow details"
                        >
                          Details
                        </Link>
                      </td>
                      {showFinanceQueueActionsColumn ? (
                        <td>
                          <div className="finance-home__row-actions finance-home__row-actions--unified-queue">
                            {quoteFinPending ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary btn--compact"
                                  onClick={() => handleApproveQuoteFinance(row)}
                                >
                                  Approve invoice
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact finance-home__btn-reject"
                                  onClick={() => openRejectQuoteFinance(row)}
                                >
                                  Reject…
                                </button>
                              </>
                            ) : null}
                            {poPending ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary btn--compact"
                                  onClick={() => handleApprovePoFinance(row)}
                                >
                                  Approve PO
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact finance-home__btn-reject"
                                  onClick={() => openRejectPoFinance(row)}
                                >
                                  Reject PO…
                                </button>
                              </>
                            ) : null}
                            {ovfFinancePending(row) ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary btn--compact"
                                  onClick={() => handleApprove(row)}
                                >
                                  Approve OVF
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact finance-home__btn-reject"
                                  onClick={() => openReject(row)}
                                >
                                  Reject OVF…
                                </button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="finance-home__section finance-home__section--approved">
        <h3 className="finance-home__section-title">Approved by Finance</h3>
        {approvedTotals.count > 0 ? (
          <p className="muted finance-home__section-desc">
            <strong>{approvedTotals.count}</strong> OVF{approvedTotals.count === 1 ? '' : 's'} — margin{' '}
            <strong>{formatInr(approvedTotals.totalMargin)}</strong> · sell{' '}
            <strong>{formatInr(approvedTotals.totalSell)}</strong> INR
          </p>
        ) : null}
        {approvedMetrics.length === 0 ? (
          <p className="muted finance-home__empty">No approved OVFs in this workspace yet.</p>
        ) : (
          <div className="finance-home__table-wrap">
            <table className="finance-home__table finance-home__table--approved">
              <thead>
                <tr>
                  <th scope="col">OVF</th>
                  <th scope="col">Quote</th>
                  <th scope="col">OVF owner</th>
                  <th scope="col">Customer</th>
                  <th scope="col" className="finance-home__th--num">
                    Sell (INR)
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Purchase (INR)
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Margin
                  </th>
                  <th scope="col" className="finance-home__th--num">
                    Margin %
                  </th>
                  <th scope="col">Approved</th>
                  <th scope="col" className="finance-home__th--details">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {approvedMetrics.map((m) => {
                  const { row, ovfRef, margins, owner } = m
                  const ovf = row.ovf!
                  const form = normalizeQuoteFormData(
                    row.formSnapshot as QuoteFormData & { customerTitle?: string },
                  )
                  const quoteNo =
                    (ovf.fields.quoteNumber || row.quoteRef || '').trim() || '—'
                  const decided = ovf.financeDecisionAt
                  return (
                    <tr key={row.id}>
                      <td className="finance-home__td--ovf-ref">{ovfRef}</td>
                      <td className="finance-home__td--quote-ref">{quoteNo}</td>
                      <td>{owner}</td>
                      <td>{(ovf.fields.customerName || form.customerName || '').trim() || '—'}</td>
                      <td className="finance-home__td--num">{formatInr(m.totalSellInr)}</td>
                      <td className="finance-home__td--num">{formatInr(m.totalPurchaseInr)}</td>
                      <td className="finance-home__td--num">{margins.margin}</td>
                      <td className="finance-home__td--num">{margins.marginPercent}</td>
                      <td>
                        {decided
                          ? new Date(decided).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : '—'}
                      </td>
                      <td className="finance-home__td--details">
                        <Link
                          to={`/finance/q/${row.id}/workflow`}
                          className="btn btn-ghost btn--compact"
                          aria-label="Open quote workflow details — documents and downloads"
                          title="Full quote finance workflow: lines, OVF, attachments, download OVF"
                        >
                          Details
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="finance-home__section finance-home__section--rejected">
        <h3 className="finance-home__section-title">Returned to Sales</h3>
        {rejected.length === 0 ? (
          <p className="muted finance-home__empty">No rejections recorded.</p>
        ) : (
          <div className="finance-home__table-wrap">
            <table className="finance-home__table finance-home__table--rejected">
              <thead>
                <tr>
                  <th scope="col">OVF</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Returned</th>
                  <th scope="col">Reason to Sales</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((row) => {
                  const ovf = row.ovf!
                  const form = normalizeQuoteFormData(
                    row.formSnapshot as QuoteFormData & { customerTitle?: string },
                  )
                  const note = (ovf.financeRejectionNote ?? '').trim()
                  const short =
                    note.length > 120 ? `${note.slice(0, 117).trimEnd()}…` : note || '—'
                  return (
                    <tr key={row.id}>
                      <td>{ovf.ovfRef}</td>
                      <td>{(ovf.fields.customerName || form.customerName || '').trim() || '—'}</td>
                      <td>
                        {ovf.financeDecisionAt
                          ? new Date(ovf.financeDecisionAt).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : '—'}
                      </td>
                      <td className="finance-home__td--note" title={note || undefined}>
                        {short}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rejectQuoteFinanceFor?.quoteFinanceReview ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setRejectQuoteFinanceFor(null)
            setRejectQuoteFinanceNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finance-quote-reject-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="finance-quote-reject-title" className="modal-card__title">
              Reject quote {rejectQuoteFinanceFor.quoteRef}
            </h3>
            <label className="field modal-card__field">
              <span className="field__label">Reason (shown to Sales)</span>
              <textarea
                className="field__control"
                rows={3}
                value={rejectQuoteFinanceNote}
                onChange={(e) => setRejectQuoteFinanceNote(e.target.value)}
              />
            </label>
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRejectQuoteFinanceFor(null)
                  setRejectQuoteFinanceNote('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => confirmRejectQuoteFinance()}
              >
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rejectPoFinanceFor?.poFinanceReview ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setRejectPoFinanceFor(null)
            setRejectPoFinanceNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finance-po-reject-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="finance-po-reject-title" className="modal-card__title">
              Reject customer PO — {rejectPoFinanceFor.quoteRef}
            </h3>
            <label className="field modal-card__field">
              <span className="field__label">Reason (shown to Sales)</span>
              <textarea
                className="field__control"
                rows={3}
                value={rejectPoFinanceNote}
                onChange={(e) => setRejectPoFinanceNote(e.target.value)}
              />
            </label>
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRejectPoFinanceFor(null)
                  setRejectPoFinanceNote('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => confirmRejectPoFinance()}
              >
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rejectFor?.ovf ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setRejectFor(null)
            setRejectNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finance-reject-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="finance-reject-title" className="modal-card__title">
              Reject {rejectFor.ovf.ovfRef}
            </h3>
            <label className="field modal-card__field">
              <span className="field__label">Reason (shown to Sales)</span>
              <textarea
                className="field__control"
                rows={3}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
            </label>
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRejectFor(null)
                  setRejectNote('')
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => confirmReject()}>
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
