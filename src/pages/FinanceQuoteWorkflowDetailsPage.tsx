import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { QuoteHtmlPreview } from '../components/QuoteHtmlPreview'
import { useAuth } from '../context/useAuth'
import {
  effectivePoFinanceStatus,
  effectiveQuoteFinanceStatus,
  usesInvoiceQuotePipeline,
} from '../lib/quotePipeline'
import { mergeOvfForAutosave, effectiveOvfWorkflow } from '../lib/ovfWorkflow'
import {
  getSavedQuoteById,
  mergePoFinanceReviewOnRecord,
  mergeQuoteFinanceReviewOnRecord,
  resolveQuoteSavedByDisplayName,
  SAVED_QUOTES_LOCAL_STORAGE_KEY,
  updateSavedQuoteOvfByRecordId,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { filterCommercialLines } from '../lib/quoteLineItems'
import { quoteFinanceEconomics } from '../lib/quoteFinanceEconomics'
import { extraChargeInrFromField, formatChargeFieldForMeta } from '../lib/ovfExtraCharges'
import {
  computeOvfAggregateEconomics,
  getOvfMarginDisplayStrings,
  hasAnyVendorPurchase,
  normalizeVendorPurchaseMap,
} from '../lib/ovfVendorEconomics'
import {
  downloadBlob,
  proofAttachmentBlobAsync,
  quotePoBlob,
  saveBlobForDesktopOpen,
  spreadsheetAttachmentKind,
} from '../lib/quoteExport'
import { buildQuoteTwoPagePdf, lineAmount } from '../lib/quotePdfTemplate'
import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'
import { downloadOvf } from '../lib/generateOvf'

function safeAttachmentDownloadFilename(name: string, fallback: string): string {
  const t = name.trim() || fallback
  const x = t.replace(/[/\\?%*:|"<>]/g, '_').trim()
  return x.slice(0, 200) || fallback
}

function attachmentPreviewMode(
  blob: Blob,
  fileLabel: string,
): 'pdf' | 'image' | 'unsupported' {
  const name = (fileLabel || '').toLowerCase()
  const ty = (blob.type || '').toLowerCase()
  if (ty === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (ty.startsWith('image/')) return 'image'
  if (/\.(jpe?g|png|gif|webp|bmp|tiff?|heic)$/.test(name)) return 'image'
  return 'unsupported'
}

function DocEyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function DocDownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"
      />
    </svg>
  )
}

/** Open full OVF + download HTML — must stay available after Finance approves (pending-decision card is hidden). */
function OvfWorkflowDocTools({
  quoteRecordId,
  record,
  docKindLabel,
  layout = 'inline',
}: {
  quoteRecordId: string
  record: SavedQuoteRecord
  docKindLabel?: string
  layout?: 'inline' | 'decision'
}) {
  return (
    <div
      className={`finance-workflow-detail__doc-tools finance-workflow-detail__doc-tools--ovf-inline${
        layout === 'decision' ? ' finance-workflow-detail__doc-tools--decision' : ''
      }`}
      role="group"
      aria-label="OVF document"
    >
      {docKindLabel ? (
        <span className="finance-workflow-detail__doc-kind">{docKindLabel}</span>
      ) : null}
      <Link
        to={`/finance/q/${quoteRecordId}/ovf`}
        state={{ financeBackTo: `/finance/q/${quoteRecordId}/workflow` }}
        className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
        aria-label="Open full OVF"
        title="Open full OVF"
      >
        <DocEyeIcon className="finance-home__btn-preview-attachment-icon" />
      </Link>
      <button
        type="button"
        className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
        onClick={() => downloadOvf(record)}
        aria-label="Download OVF (HTML)"
        title="Download OVF (HTML)"
      >
        <DocDownloadIcon className="finance-home__btn-preview-attachment-icon" />
      </button>
    </div>
  )
}

function formatTs(iso: string | undefined): string {
  if (!iso?.trim()) return '—'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso.trim()
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function quoteFinanceStatusLabel(
  s: 'none' | 'pending_finance' | 'finance_approved' | 'finance_rejected',
): string {
  if (s === 'pending_finance') return 'Pending Finance review'
  if (s === 'finance_approved') return 'Approved'
  if (s === 'finance_rejected') return 'Rejected'
  return '—'
}

function poFinanceStatusLabel(
  s: 'none' | 'pending_finance' | 'finance_approved' | 'finance_rejected',
): string {
  if (s === 'pending_finance') return 'Pending Finance (customer PO)'
  if (s === 'finance_approved') return 'Approved'
  if (s === 'finance_rejected') return 'Rejected'
  return 'Not submitted'
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** INR amount from a numeric-ish string; null if not a number. */
function parseMoneyField(raw: string | undefined): number | null {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

/** Qty × vendor invoice unit rate when both are present. */
function vendorLineTotal(line: QuoteLineForm): number | null {
  const vu = line.vendorUnitPrice
  if (vu === undefined || !String(vu).trim()) return null
  const rate = parseMoneyField(vu)
  const qty = parseMoneyField(line.qty)
  if (rate === null || qty === null) return null
  return qty * rate
}

function ovfWorkflowLabel(s: string | undefined): string {
  switch (s) {
    case 'sales_draft':
      return 'Sales draft'
    case 'pending_finance':
      return 'Pending Finance'
    case 'finance_rejected':
      return 'Rejected'
    case 'finance_approved':
      return 'Approved'
    default:
      return s?.trim() ? s : '—'
  }
}

type TimelineRow = {
  ts: number
  iso: string
  title: string
  detail?: string
}

function buildTimeline(record: SavedQuoteRecord): TimelineRow[] {
  const rows: TimelineRow[] = []
  const push = (iso: string | undefined, title: string, detail?: string) => {
    if (!iso?.trim()) return
    const trimmed = iso.trim()
    const ts = Date.parse(trimmed)
    if (!Number.isFinite(ts)) return
    rows.push({ ts, iso: trimmed, title, detail })
  }

  push(record.savedAt, 'Quote finalized', `Saved by ${record.savedByDisplayName?.trim() || resolveQuoteSavedByDisplayName(record.savedBy)}`)

  const qfr = record.quoteFinanceReview
  if (qfr?.vendorInvoice?.uploadedAt) {
    push(
      qfr.vendorInvoice.uploadedAt,
      'Vendor invoice file attached',
      qfr.vendorInvoice.fileName?.trim() || undefined,
    )
  }
  push(qfr?.submittedToFinanceAt, 'Quote & vendor invoice submitted to Finance queue')

  if (qfr?.financeDecisionAt) {
    const qfs = effectiveQuoteFinanceStatus(record)
    push(
      qfr.financeDecisionAt,
      `Quote finance decision — ${quoteFinanceStatusLabel(qfs)}`,
      [
        qfr.financeApprovedBy?.trim() ? `By ${qfr.financeApprovedBy.trim()}` : '',
        qfr.financeRejectionNote?.trim()
          ? `Note: ${qfr.financeRejectionNote.trim()}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    )
  }

  push(
    record.customerQuoteShipment?.sentToCustomerAt,
    'Sales marked quotation as sent to customer',
  )

  const po = record.po
  if (po?.uploadedAt) {
    push(
      po.uploadedAt,
      'Customer PO file uploaded',
      [
        po.customerPoNumber?.trim() ? `Ref: ${po.customerPoNumber.trim()}` : '',
        po.poTotalInr?.trim() ? `Declared total: ${po.poTotalInr.trim()} INR` : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    )
  }
  if (po?.comparedAt) {
    push(po.comparedAt, 'Customer PO total compared to quote')
  }

  const pfr = record.poFinanceReview
  push(pfr?.submittedToFinanceAt, 'Customer PO submitted to Finance for GST check')

  if (pfr?.financeDecisionAt) {
    const pfs = effectivePoFinanceStatus(record)
    push(
      pfr.financeDecisionAt,
      `Customer PO finance decision — ${poFinanceStatusLabel(pfs)}`,
      [
        pfr.financeApprovedBy?.trim() ? `By ${pfr.financeApprovedBy.trim()}` : '',
        pfr.financeRejectionNote?.trim()
          ? `Note: ${pfr.financeRejectionNote.trim()}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    )
  }

  const ovf = record.ovf
  if (ovf) {
    push(ovf.submittedToFinanceAt, 'OVF submitted to Finance', ovf.ovfRef ? `Ref ${ovf.ovfRef}` : undefined)
    if (ovf.financeDecisionAt) {
      push(
        ovf.financeDecisionAt,
        `OVF finance decision — ${ovfWorkflowLabel(ovf.workflowStatus)}`,
        [
          ovf.financeApprovedBy?.trim() ? `By ${ovf.financeApprovedBy.trim()}` : '',
          ovf.financeRejectionNote?.trim()
            ? `Note: ${ovf.financeRejectionNote.trim()}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      )
    }
    push(ovf.updatedAt, 'OVF last updated')
  }

  const scm = record.scmPo
  if (scm) {
    push(scm.createdAt, 'SCM vendor PO created', scm.poRef ? `Ref ${scm.poRef}` : undefined)
    push(scm.updatedAt, 'SCM vendor PO last updated', scm.status === 'final' ? 'Status: final' : 'Status: draft')
  }

  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

export function FinanceQuoteWorkflowDetailsPage() {
  const { quoteId } = useParams<{ quoteId: string }>()
  const { user } = useAuth()
  const [version, setVersion] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rejectQuoteFinanceNote, setRejectQuoteFinanceNote] = useState('')
  const [showRejectQuoteFinance, setShowRejectQuoteFinance] = useState(false)
  const [rejectPoFinanceNote, setRejectPoFinanceNote] = useState('')
  const [showRejectPoFinance, setShowRejectPoFinance] = useState(false)
  const [rejectOvfNote, setRejectOvfNote] = useState('')
  const [showRejectOvf, setShowRejectOvf] = useState(false)
  const [quotePreviewOpen, setQuotePreviewOpen] = useState(false)
  const [quotePdfDownloading, setQuotePdfDownloading] = useState(false)
  const [invoiceAttachmentPreview, setInvoiceAttachmentPreview] = useState<{
    title: string
    fileLabel: string
    blob: Blob
    downloadFilename: string
  } | null>(null)

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_QUOTES_LOCAL_STORAGE_KEY) refresh()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [refresh])

  const invoiceAttachmentPreviewUrl = useMemo(() => {
    if (!invoiceAttachmentPreview) return null
    return URL.createObjectURL(invoiceAttachmentPreview.blob)
  }, [invoiceAttachmentPreview])

  useEffect(() => {
    return () => {
      if (invoiceAttachmentPreviewUrl) URL.revokeObjectURL(invoiceAttachmentPreviewUrl)
    }
  }, [invoiceAttachmentPreviewUrl])

  const invoiceAttachmentPreviewMode = useMemo(() => {
    if (!invoiceAttachmentPreview) return null
    return attachmentPreviewMode(
      invoiceAttachmentPreview.blob,
      invoiceAttachmentPreview.fileLabel,
    )
  }, [invoiceAttachmentPreview])

  const invoiceAttachmentSpreadsheetKind = useMemo(() => {
    if (!invoiceAttachmentPreview) return null
    return spreadsheetAttachmentKind(
      invoiceAttachmentPreview.blob,
      invoiceAttachmentPreview.fileLabel,
    )
  }, [invoiceAttachmentPreview])

  const record = useMemo(() => {
    void version
    const id = quoteId?.trim()
    if (!id) return undefined
    return getSavedQuoteById(id)
  }, [quoteId, version])

  const summary = useMemo(() => {
    if (!record) return null
    const form = normalizeQuoteFormData(
      record.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
    const econ = quoteFinanceEconomics(form, record.quoteFinanceReview)
    return { form, econ }
  }, [record])

  const timeline = useMemo(() => (record ? buildTimeline(record) : []), [record])

  const commercialLines = useMemo(() => {
    if (!summary) return []
    return filterCommercialLines(summary.form.lineItems)
  }, [summary])

  const vendorLinesSum = useMemo(() => {
    let s = 0
    for (const line of commercialLines) {
      const v = vendorLineTotal(line)
      if (v != null) s += v
    }
    return s
  }, [commercialLines])

  const vendorRatesPresent = useMemo(
    () => commercialLines.some((l) => vendorLineTotal(l) != null),
    [commercialLines],
  )

  /** Bridge line-sum purchase to Finance summary (deposit vs invoice net). */
  /** Same freight/finance basis as Finance queue & OVF vendor section (line purchase + extras). */
  const ovfCommercialSnapshot = useMemo(() => {
    if (!record?.ovf || !summary) return null
    const ovf = record.ovf
    const commercial = filterCommercialLines(summary.form.lineItems)
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
    const marginDisplay = getOvfMarginDisplayStrings(
      ovf.fields,
      commercial,
      agg,
      vendorExtrasInr,
    )
    const hasVp = hasAnyVendorPurchase(commercial, vendorMap)
    const totalVendorCostInr = agg.totalPurchase + vendorExtrasInr
    const marginInr = hasVp
      ? agg.totalSell - totalVendorCostInr
      : parseMoneyField(ovf.fields.margin) ?? 0
    const marginPct =
      hasVp && agg.totalSell > 0 ? (marginInr / agg.totalSell) * 100 : null
    return {
      agg,
      freightInr,
      financeInr,
      vendorExtrasInr,
      totalVendorCostInr,
      marginDisplay,
      hasVp,
      marginInr,
      marginPct,
    }
  }, [record, summary])

  const ovfChargeMetaLines = useMemo(() => {
    if (!record?.ovf || !ovfCommercialSnapshot) return { freight: '', finance: '' }
    const basis = ovfCommercialSnapshot.agg.totalPurchase
    const f = record.ovf.fields
    return {
      freight: formatChargeFieldForMeta(
        f.freightCharges,
        f.freightChargesUnit,
        basis,
        formatInr,
        'vendor purchase',
      ).trim(),
      finance: formatChargeFieldForMeta(
        f.financeCost,
        f.financeCostUnit,
        basis,
        formatInr,
        'vendor purchase',
      ).trim(),
    }
  }, [record, ovfCommercialSnapshot])

  const purchaseReconciliation = useMemo(() => {
    if (!record || !summary?.econ?.hasVendorCosts) return null
    const lineSum = vendorLinesSum
    const fin = summary.econ.purchaseTotal
    const qfr = record.quoteFinanceReview
    const depRaw = qfr?.vendorDepositInr
    const depositInr =
      depRaw != null && Number.isFinite(depRaw) && depRaw >= 0 ? depRaw : undefined
    if (Math.abs(lineSum - fin) < 0.01) {
      return { aligned: true as const }
    }
    const gap = lineSum - fin
    const depositExplains =
      depositInr !== undefined && Math.abs(lineSum - depositInr - fin) < 0.01
    return {
      aligned: false as const,
      lineSum,
      fin,
      gap,
      depositInr,
      depositExplains,
      usesStoredNet:
        qfr?.vendorNetPurchaseInr != null && Number.isFinite(qfr.vendorNetPurchaseInr),
    }
  }, [record, summary, vendorLinesSum])

  const quoteFinPending = useMemo(
    () => Boolean(record && effectiveQuoteFinanceStatus(record) === 'pending_finance'),
    [record],
  )
  const poFinPending = useMemo(
    () => Boolean(record && effectivePoFinanceStatus(record) === 'pending_finance'),
    [record],
  )
  const ovfFinPending = useMemo(
    () =>
      Boolean(
        record?.ovf && effectiveOvfWorkflow(record.ovf) === 'pending_finance',
      ),
    [record],
  )

  const handleApproveQuoteFinance = useCallback(() => {
    if (!user || !record?.quoteFinanceReview) return
    const form = normalizeQuoteFormData(
      record.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
    const econ = quoteFinanceEconomics(form, record.quoteFinanceReview)
    const econNote = econ.hasVendorCosts
      ? `\n\nSell ${formatInr(econ.sellTotal)} · Purchase (est.) ${formatInr(econ.purchaseTotal)} · Margin ${formatInr(econ.marginInr)} (${econ.marginPct != null ? `${econ.marginPct.toFixed(2)}%` : '—'}).`
      : ''
    if (
      !window.confirm(
        `Approve quote ${record.quoteRef} (vendor invoice) so Sales can send it to the customer?${econNote}`,
      )
    ) {
      return
    }
    const now = new Date().toISOString()
    const merged = mergeQuoteFinanceReviewOnRecord(record.id, {
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
  }, [user, record, refresh])

  const confirmRejectQuoteFinance = useCallback(() => {
    if (!user || !record?.quoteFinanceReview) return
    const note = rejectQuoteFinanceNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergeQuoteFinanceReviewOnRecord(record.id, {
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setShowRejectQuoteFinance(false)
    setRejectQuoteFinanceNote('')
    if (!merged) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, record, rejectQuoteFinanceNote, refresh])

  const handleApprovePoFinance = useCallback(() => {
    if (!user || !record) return
    if (effectivePoFinanceStatus(record) !== 'pending_finance') return
    if (
      !window.confirm(
        `Approve customer PO GST check for quote ${record.quoteRef}? Sales can then create the OVF.`,
      )
    ) {
      return
    }
    const now = new Date().toISOString()
    const merged = mergePoFinanceReviewOnRecord(record.id, {
      workflowStatus: 'finance_approved',
      financeApprovedBy: user.displayName?.trim() || user.oid,
      financeApprovedByOid: user.oid,
      financeDecisionAt: now,
      financeRejectionNote: undefined,
    })
    if (!merged) {
      setActionError(
        'Could not save approval — storage may be full or blocked. Clear site data or free space, then try again.',
      )
      window.setTimeout(() => setActionError(null), 8000)
      return
    }
    refresh()
  }, [user, record, refresh])

  const confirmRejectPoFinance = useCallback(() => {
    if (!user || !record?.poFinanceReview) return
    const note = rejectPoFinanceNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergePoFinanceReviewOnRecord(record.id, {
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setShowRejectPoFinance(false)
    setRejectPoFinanceNote('')
    if (!merged) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, record, rejectPoFinanceNote, refresh])

  const handleApproveOvf = useCallback(() => {
    if (!user || !record?.ovf) return
    if (
      !window.confirm(
        `Approve ${record.ovf.ovfRef} for SCM? Sales will no longer edit this OVF.`,
      )
    ) {
      return
    }
    const merged = mergeOvfForAutosave(record.ovf, record.ovf.ovfRef, record.ovf.fields)
    const next = updateSavedQuoteOvfByRecordId(record.id, {
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
  }, [user, record, refresh])

  const confirmRejectOvf = useCallback(() => {
    if (!user || !record?.ovf) return
    const note = rejectOvfNote.trim()
    if (!note) {
      setActionError('Add a short reason for Sales.')
      window.setTimeout(() => setActionError(null), 5000)
      return
    }
    const merged = mergeOvfForAutosave(
      record.ovf,
      record.ovf.ovfRef,
      record.ovf.fields,
    )
    const next = updateSavedQuoteOvfByRecordId(record.id, {
      ...merged,
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    setShowRejectOvf(false)
    setRejectOvfNote('')
    if (!next) {
      setActionError('Could not save rejection.')
      window.setTimeout(() => setActionError(null), 6000)
      return
    }
    refresh()
  }, [user, record, rejectOvfNote, refresh])

  const downloadQuotePdf = useCallback(async () => {
    if (!record) return
    setQuotePdfDownloading(true)
    setActionError(null)
    try {
      const safe = record.quoteRef.replace(/[^\w.-]+/g, '_') || 'quote'
      const blob = await buildQuoteTwoPagePdf(
        record.formSnapshot as QuoteFormData & { customerTitle?: string },
      )
      downloadBlob(blob, `${safe}.pdf`)
    } catch {
      setActionError('Could not generate the quote PDF. Try again.')
      window.setTimeout(() => setActionError(null), 6000)
    } finally {
      setQuotePdfDownloading(false)
    }
  }, [record])

  const openVendorInvoicePreview = useCallback(() => {
    const inv = record?.quoteFinanceReview?.vendorInvoice
    if (!inv) return
    void (async () => {
      try {
        const blob = await proofAttachmentBlobAsync(inv)
        setInvoiceAttachmentPreview({
          title: 'Vendor invoice',
          fileLabel: (inv.fileName || 'Invoice').trim() || 'Invoice',
          blob,
          downloadFilename: safeAttachmentDownloadFilename(inv.fileName || '', 'vendor-invoice.pdf'),
        })
      } catch {
        setActionError('Could not open the vendor invoice preview. Try downloading it instead.')
        window.setTimeout(() => setActionError(null), 6000)
      }
    })()
  }, [record])

  const openCustomerPoPreview = useCallback(() => {
    const po = record?.po
    if (!po) return
    setInvoiceAttachmentPreview({
      title: 'Customer PO',
      fileLabel: (po.fileName || 'Customer PO').trim() || 'Customer PO',
      blob: quotePoBlob(po),
      downloadFilename: safeAttachmentDownloadFilename(po.fileName || '', 'customer-po.pdf'),
    })
  }, [record])

  if (!quoteId?.trim()) {
    return <Navigate to="/finance" replace />
  }

  if (!record) {
    return (
      <section className="panel finance-home finance-workflow-detail">
        <p className="finance-workflow-detail__lead">
          No quote found for this link (it may have been removed or opened in another browser profile).
        </p>
        <Link to="/finance" className="btn btn-ghost">
          ← Back to Finance overview
        </Link>
      </section>
    )
  }

  const invoicePath = usesInvoiceQuotePipeline(record)
  const vendorInvoice = record.quoteFinanceReview?.vendorInvoice

  return (
    <section className="panel finance-home finance-workflow-detail">
      <nav className="finance-workflow-detail__nav">
        <Link to="/finance" className="finance-workflow-detail__back">
          ← Finance overview
        </Link>
      </nav>

      <header className="finance-workflow-detail__header">
        <h1 className="finance-workflow-detail__title">
          {record.quoteRef || 'Quote'}
        </h1>
        <p className="finance-workflow-detail__subtitle muted">
          {summary?.form.customerName.trim() || 'Customer'} · Sales:{' '}
          {(record.savedByDisplayName ?? '').trim() ||
            resolveQuoteSavedByDisplayName(record.savedBy)}
          {invoicePath ? ' · Vendor invoice pipeline' : ''}
        </p>
      </header>

      {actionError ? (
        <p
          className="finance-home__banner finance-home__banner--err finance-workflow-detail__action-banner"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      <section className="finance-workflow-detail__section" aria-labelledby="wf-summary-heading">
        <h2 id="wf-summary-heading" className="finance-workflow-detail__h2">
          Summary
        </h2>
        <dl className="finance-workflow-detail__dl">
          <div>
            <dt>Quote ref</dt>
            <dd>{record.quoteRef || '—'}</dd>
          </div>
          <div>
            <dt>Record saved</dt>
            <dd>{formatTs(record.savedAt)}</dd>
          </div>
          <div>
            <dt>Sell total</dt>
            <dd>
              {summary?.econ ? summary.econ.sellTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
            </dd>
          </div>
          <div>
            <dt>Purchase (vendor)</dt>
            <dd className="finance-workflow-detail__purchase-dd">
              {summary?.econ?.hasVendorCosts ? (
                summary.econ.linePurchaseTotal > 0.005 ? (
                  <>
                    <div className="finance-workflow-detail__purchase-line">
                      <strong>
                        {summary.econ.linePurchaseTotal.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                        })}
                      </strong>{' '}
                      <span className="muted">(gross · qty × vendor rate)</span>
                    </div>
                    {Math.abs(
                      summary.econ.linePurchaseTotal - summary.econ.purchaseTotal,
                    ) > 0.005 ? (
                      <div className="finance-workflow-detail__purchase-net muted">
                        Net payable (margin basis){' '}
                        <strong className="finance-workflow-detail__purchase-net-strong">
                          {summary.econ.purchaseTotal.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                          })}
                        </strong>
                        {summary.econ.vendorDepositInr != null &&
                        summary.econ.vendorDepositInr > 0 ? (
                          <>
                            {' '}
                            · Less deposit{' '}
                            {summary.econ.vendorDepositInr.toLocaleString('en-IN', {
                              minimumFractionDigits: 2,
                            })}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="finance-workflow-detail__purchase-line">
                    <strong>
                      {summary.econ.purchaseTotal.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                      })}
                    </strong>{' '}
                    <span className="muted">(net from invoice)</span>
                  </div>
                )
              ) : (
                '—'
              )}
            </dd>
          </div>
          {ovfCommercialSnapshot && record.ovf ? (
            <>
              <div>
                <dt>Freight charges (OVF)</dt>
                <dd className="finance-workflow-detail__purchase-dd">
                  <div className="finance-workflow-detail__purchase-line">
                    <strong>{formatInr(ovfCommercialSnapshot.freightInr)}</strong>
                  </div>
                  {ovfChargeMetaLines.freight ? (
                    <div className="muted finance-workflow-detail__purchase-net">
                      {ovfChargeMetaLines.freight}
                    </div>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Finance cost (OVF)</dt>
                <dd className="finance-workflow-detail__purchase-dd">
                  <div className="finance-workflow-detail__purchase-line">
                    <strong>{formatInr(ovfCommercialSnapshot.financeInr)}</strong>
                  </div>
                  {ovfChargeMetaLines.finance ? (
                    <div className="muted finance-workflow-detail__purchase-net">
                      {ovfChargeMetaLines.finance}
                    </div>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Total vendor cost (OVF)</dt>
                <dd>
                  <strong>{formatInr(ovfCommercialSnapshot.totalVendorCostInr)}</strong>
                  <span className="muted">
                    {' '}
                    (vendor line purchase + freight + finance; same basis as Finance queue &amp; OVF)
                  </span>
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>{ovfCommercialSnapshot ? 'Margin (OVF basis)' : 'Margin'}</dt>
            <dd>
              {ovfCommercialSnapshot
                ? `${ovfCommercialSnapshot.marginDisplay.margin} (${ovfCommercialSnapshot.marginDisplay.marginPercent})`
                : summary?.econ?.hasVendorCosts
                  ? `${summary.econ.marginInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${summary.econ.marginPct != null ? `${summary.econ.marginPct.toFixed(2)}%` : '—'})`
                  : '—'}
            </dd>
          </div>
          <div>
            <dt>Quote finance</dt>
            <dd>{quoteFinanceStatusLabel(effectiveQuoteFinanceStatus(record))}</dd>
          </div>
          <div>
            <dt>Customer PO finance</dt>
            <dd>{poFinanceStatusLabel(effectivePoFinanceStatus(record))}</dd>
          </div>
          <div>
            <dt>OVF</dt>
            <dd>
              {record.ovf ? (
                <div className="finance-workflow-detail__dl-ovf-row">
                  <span className="finance-workflow-detail__dl-ovf-summary-text">
                    {`${record.ovf.ovfRef} (${ovfWorkflowLabel(record.ovf.workflowStatus)})`}
                  </span>
                  <OvfWorkflowDocTools
                    quoteRecordId={record.id}
                    record={record}
                    docKindLabel="OVF"
                  />
                </div>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>SCM vendor PO</dt>
            <dd>
              {record.scmPo
                ? `${record.scmPo.poRef} (${record.scmPo.status})`
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="finance-workflow-detail__section" aria-labelledby="wf-customer-lines-heading">
        <div className="finance-workflow-detail__section-head">
          <h2 id="wf-customer-lines-heading" className="finance-workflow-detail__h2">
            Customer quotation — line items (sell)
          </h2>
          <div className="finance-workflow-detail__doc-tools" role="group" aria-label="Quote document">
            <span className="finance-workflow-detail__doc-kind">Quote</span>
            <button
              type="button"
              className="finance-home__btn-preview-quote finance-workflow-detail__doc-icon-btn"
              onClick={() => setQuotePreviewOpen(true)}
              aria-label="Preview quote"
              title="Preview quote"
            >
              <DocEyeIcon className="finance-home__btn-preview-quote-icon" />
            </button>
            <button
              type="button"
              className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
              onClick={() => void downloadQuotePdf()}
              disabled={quotePdfDownloading}
              aria-label="Download quote PDF"
              title="Download quote PDF"
            >
              <DocDownloadIcon className="finance-home__btn-preview-attachment-icon" />
            </button>
          </div>
        </div>
        <p className="finance-workflow-detail__table-intro muted">
          What is offered to the buyer: product, specification, quantity, customer unit price and line
          amount (same basis as the quote PDF).
        </p>
        {commercialLines.length === 0 ? (
          <p className="muted">No commercial line items on this quote.</p>
        ) : (
          <div className="finance-workflow-detail__table-wrap">
            <table className="finance-workflow-detail__table">
              <thead>
                <tr>
                  <th scope="col" className="finance-workflow-detail__cell--narrow">
                    #
                  </th>
                  <th scope="col">Product</th>
                  <th scope="col">Description / spec</th>
                  <th scope="col" className="finance-workflow-detail__cell--num">
                    Qty
                  </th>
                  <th scope="col" className="finance-workflow-detail__cell--num">
                    Unit price (INR)
                  </th>
                  <th scope="col" className="finance-workflow-detail__cell--num">
                    Line total (INR)
                  </th>
                </tr>
              </thead>
              <tbody>
                {commercialLines.map((line, idx) => (
                  <tr key={line.id}>
                    <td className="finance-workflow-detail__cell--narrow muted">{idx + 1}</td>
                    <td>{line.product.trim() || '—'}</td>
                    <td className="finance-workflow-detail__cell--pre">{line.description.trim() || '—'}</td>
                    <td className="finance-workflow-detail__cell--num">{line.qty.trim() || '—'}</td>
                    <td className="finance-workflow-detail__cell--num">
                      {parseMoneyField(line.unitPrice) != null
                        ? formatInr(parseMoneyField(line.unitPrice)!)
                        : line.unitPrice.trim() || '—'}
                    </td>
                    <td className="finance-workflow-detail__cell--num">{formatInr(lineAmount(line))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="finance-workflow-detail__cell--foot-label">
                    Quote sell total
                  </td>
                  <td className="finance-workflow-detail__cell--num finance-workflow-detail__cell--foot-num">
                    {summary?.econ ? formatInr(summary.econ.sellTotal) : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="finance-workflow-detail__section" aria-labelledby="wf-vendor-lines-heading">
        <div className="finance-workflow-detail__section-head">
          <h2 id="wf-vendor-lines-heading" className="finance-workflow-detail__h2">
            Vendor purchase — line items (buy)
          </h2>
          <div className="finance-workflow-detail__doc-tools" role="group" aria-label="Supplier invoice">
            <span className="finance-workflow-detail__doc-kind">Invoice</span>
            {vendorInvoice ? (
              <>
                <button
                  type="button"
                  className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
                  onClick={() => openVendorInvoicePreview()}
                  aria-label="Preview supplier invoice"
                  title="Preview supplier invoice"
                >
                  <DocEyeIcon className="finance-home__btn-preview-attachment-icon" />
                </button>
                <button
                  type="button"
                  className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
                  onClick={() =>
                    void (async () => {
                      try {
                        const blob = await proofAttachmentBlobAsync(vendorInvoice)
                        downloadBlob(
                          blob,
                          safeAttachmentDownloadFilename(
                            vendorInvoice.fileName || '',
                            'vendor-invoice.pdf',
                          ),
                        )
                      } catch {
                        setActionError('Could not download the vendor invoice. Try again.')
                        window.setTimeout(() => setActionError(null), 6000)
                      }
                    })()
                  }
                  aria-label="Download supplier invoice"
                  title="Download supplier invoice"
                >
                  <DocDownloadIcon className="finance-home__btn-preview-attachment-icon" />
                </button>
              </>
            ) : (
              <span className="muted finance-workflow-detail__doc-missing">No invoice file</span>
            )}
          </div>
        </div>
        <p className="finance-workflow-detail__table-intro muted">
          Unit rates from the supplier invoice import (qty × vendor unit rate). Totals in the summary
          may use the invoice net when Finance stored it.
        </p>
        {commercialLines.length === 0 ? (
          <p className="muted">No lines to show.</p>
        ) : (
          <>
            {vendorRatesPresent ? (
              <>
            <div className="finance-workflow-detail__table-wrap">
              <table className="finance-workflow-detail__table">
                <thead>
                  <tr>
                    <th scope="col" className="finance-workflow-detail__cell--narrow">
                      #
                    </th>
                    <th scope="col">Product</th>
                    <th scope="col">Description / spec</th>
                    <th scope="col" className="finance-workflow-detail__cell--num">
                      Qty
                    </th>
                    <th scope="col" className="finance-workflow-detail__cell--num">
                      Vendor unit rate (INR)
                    </th>
                    <th scope="col" className="finance-workflow-detail__cell--num">
                      Line total (INR)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {commercialLines.map((line, idx) => {
                    const vtot = vendorLineTotal(line)
                    return (
                      <tr key={line.id}>
                        <td className="finance-workflow-detail__cell--narrow muted">{idx + 1}</td>
                        <td>{line.product.trim() || '—'}</td>
                        <td className="finance-workflow-detail__cell--pre">{line.description.trim() || '—'}</td>
                        <td className="finance-workflow-detail__cell--num">{line.qty.trim() || '—'}</td>
                        <td className="finance-workflow-detail__cell--num">
                          {parseMoneyField(line.vendorUnitPrice) != null
                            ? formatInr(parseMoneyField(line.vendorUnitPrice)!)
                            : '—'}
                        </td>
                        <td className="finance-workflow-detail__cell--num">
                          {vtot != null ? formatInr(vtot) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="finance-workflow-detail__cell--foot-label">
                      Sum of line purchases (rates × qty)
                    </td>
                    <td className="finance-workflow-detail__cell--num finance-workflow-detail__cell--foot-num">
                      {formatInr(vendorLinesSum)}
                    </td>
                  </tr>
                  {summary?.econ?.hasVendorCosts ? (
                    <tr>
                      <td colSpan={5} className="finance-workflow-detail__cell--foot-label">
                        Purchase total used in Finance summary
                      </td>
                      <td className="finance-workflow-detail__cell--num finance-workflow-detail__cell--foot-num">
                        {formatInr(summary.econ.purchaseTotal)}
                      </td>
                    </tr>
                  ) : null}
                  {ovfCommercialSnapshot ? (
                    <tr>
                      <td colSpan={5} className="finance-workflow-detail__cell--foot-label">
                        OVF total vendor cost (line purchase + freight + finance)
                      </td>
                      <td className="finance-workflow-detail__cell--num finance-workflow-detail__cell--foot-num">
                        {formatInr(ovfCommercialSnapshot.totalVendorCostInr)}
                      </td>
                    </tr>
                  ) : null}
                </tfoot>
              </table>
            </div>
            {purchaseReconciliation && !purchaseReconciliation.aligned ? (
              <div
                className="finance-workflow-detail__reconcile"
                role="region"
                aria-label="Purchase reconciliation"
              >
                <h3 className="finance-workflow-detail__reconcile-title">
                  How line total relates to Finance purchase total
                </h3>
                <table className="finance-workflow-detail__reconcile-table">
                  <tbody>
                    <tr>
                      <td>Sum of line purchases (qty × vendor rate)</td>
                      <td className="finance-workflow-detail__cell--num">
                        {formatInr(purchaseReconciliation.lineSum)}
                      </td>
                    </tr>
                    {purchaseReconciliation.depositExplains &&
                    purchaseReconciliation.depositInr !== undefined ? (
                      <tr className="finance-workflow-detail__reconcile-row--deduct">
                        <td>Less: Deposit / advance (from supplier invoice)</td>
                        <td className="finance-workflow-detail__cell--num">
                          −{formatInr(purchaseReconciliation.depositInr)}
                        </td>
                      </tr>
                    ) : (
                      <tr
                        className={
                          purchaseReconciliation.gap >= 0
                            ? 'finance-workflow-detail__reconcile-row--deduct'
                            : 'finance-workflow-detail__reconcile-row--add'
                        }
                      >
                        <td>
                          {purchaseReconciliation.gap >= 0
                            ? 'Adjustment (invoice net / balance due vs extending lines only)'
                            : 'Adjustment (invoice total higher than line extension)'}
                        </td>
                        <td className="finance-workflow-detail__cell--num">
                          {purchaseReconciliation.gap >= 0
                            ? `−${formatInr(purchaseReconciliation.gap)}`
                            : `+${formatInr(Math.abs(purchaseReconciliation.gap))}`}
                        </td>
                      </tr>
                    )}
                    <tr className="finance-workflow-detail__reconcile-row--total">
                      <th scope="row">Net vendor payable (Finance summary)</th>
                      <td className="finance-workflow-detail__cell--num">
                        {formatInr(purchaseReconciliation.fin)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {!purchaseReconciliation.depositExplains &&
                purchaseReconciliation.depositInr !== undefined &&
                purchaseReconciliation.depositInr > 0 ? (
                  <p className="finance-workflow-detail__reconcile-note muted" role="note">
                    The invoice also mentions deposit / advance{' '}
                    <strong>{formatInr(purchaseReconciliation.depositInr)}</strong>; the gap above is
                    still the difference between extending line rates and the payable total Finance
                    uses (often from <strong>balance due</strong> / <strong>net payable</strong> on
                    the invoice).
                  </p>
                ) : null}
                {purchaseReconciliation.depositExplains ? (
                  <p className="finance-workflow-detail__reconcile-note muted" role="note">
                    The deposit row is taken from the supplier invoice footer (e.g. “Less deposit” /
                    advance). Finance summary uses net payable after this deduction (or the footer
                    net when captured).
                  </p>
                ) : purchaseReconciliation.usesStoredNet ? (
                  <p className="finance-workflow-detail__reconcile-note muted" role="note">
                    Finance uses the <strong>net vendor payable</strong> read from the invoice when
                    available; that can differ from qty × rate on lines (tax, freight, rounding, or
                    balance due wording).
                  </p>
                ) : null}
              </div>
            ) : null}
              </>
            ) : (
              <p className="muted">
                No vendor unit rates are stored on these lines yet — purchase total in the summary comes
                from invoice footer net only, if present.
              </p>
            )}
            {ovfCommercialSnapshot ? (
              <div
                className="finance-workflow-detail__reconcile"
                role="region"
                aria-label="OVF costing and margin"
              >
                <h3 className="finance-workflow-detail__reconcile-title">
                  OVF costing &amp; margin (freight &amp; finance)
                </h3>
                <table className="finance-workflow-detail__reconcile-table">
                  <tbody>
                    <tr>
                      <td>Vendor line purchase (qty × vendor rate on quote lines)</td>
                      <td className="finance-workflow-detail__cell--num">
                        {formatInr(ovfCommercialSnapshot.agg.totalPurchase)}
                      </td>
                    </tr>
                    <tr>
                      <td>Add: Freight charges</td>
                      <td className="finance-workflow-detail__cell--num">
                        +{formatInr(ovfCommercialSnapshot.freightInr)}
                      </td>
                    </tr>
                    <tr>
                      <td>Add: Finance cost</td>
                      <td className="finance-workflow-detail__cell--num">
                        +{formatInr(ovfCommercialSnapshot.financeInr)}
                      </td>
                    </tr>
                    <tr className="finance-workflow-detail__reconcile-row--total">
                      <th scope="row">Total vendor cost (OVF)</th>
                      <td className="finance-workflow-detail__cell--num">
                        {formatInr(ovfCommercialSnapshot.totalVendorCostInr)}
                      </td>
                    </tr>
                    <tr>
                      <td>Quote sell total</td>
                      <td className="finance-workflow-detail__cell--num">
                        {formatInr(ovfCommercialSnapshot.agg.totalSell)}
                      </td>
                    </tr>
                    <tr className="finance-workflow-detail__reconcile-row--total">
                      <th scope="row">Margin (OVF basis)</th>
                      <td className="finance-workflow-detail__cell--num">
                        {ovfCommercialSnapshot.hasVp ? (
                          <>
                            {formatInr(ovfCommercialSnapshot.marginInr)}
                            {ovfCommercialSnapshot.marginPct != null
                              ? ` (${ovfCommercialSnapshot.marginPct.toFixed(2)}%)`
                              : ''}
                          </>
                        ) : (
                          <>
                            {ovfCommercialSnapshot.marginDisplay.margin} (
                            {ovfCommercialSnapshot.marginDisplay.marginPercent})
                          </>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="finance-workflow-detail__reconcile-note muted" role="note">
                  Same rules as the OVF form and Finance queue: freight and finance increase total
                  vendor cost and reduce margin. Percent entries apply to vendor line purchase
                  subtotal. Invoice deposit / net payable above is separate from these OVF commercial
                  fields.
                </p>
              </div>
            ) : null}
          </>
        )}
      </section>

      {quoteFinPending || poFinPending || ovfFinPending ? (
        <section
          className="finance-workflow-detail__section finance-workflow-detail__section--decisions"
          aria-labelledby="wf-decisions-heading"
        >
          <h2 id="wf-decisions-heading" className="finance-workflow-detail__h2">
            Pending Finance decisions
          </h2>
          <p className="finance-workflow-detail__decisions-intro muted">
            Review the summary and line tables above, then approve or reject. Reject requires a short
            note shown to Sales.
          </p>
          <div className="finance-workflow-detail__decision-cards">
            {quoteFinPending ? (
              <div className="finance-workflow-detail__decision-card">
                <h3 className="finance-workflow-detail__h3">Quote &amp; vendor invoice</h3>
                <p className="finance-workflow-detail__decision-desc muted">
                  Approve so Sales can send the quotation to the customer.
                </p>
                <div className="finance-workflow-detail__decision-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn--compact"
                    onClick={() => void handleApproveQuoteFinance()}
                  >
                    Approve quote
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn--compact finance-home__btn-reject"
                    onClick={() => {
                      setRejectQuoteFinanceNote('')
                      setShowRejectQuoteFinance(true)
                    }}
                  >
                    Reject…
                  </button>
                </div>
              </div>
            ) : null}
            {poFinPending ? (
              <div className="finance-workflow-detail__decision-card">
                <h3 className="finance-workflow-detail__h3">Customer PO (GST check)</h3>
                <p className="finance-workflow-detail__decision-desc muted">
                  Approve so Sales can create the OVF after PO verification.
                </p>
                <div className="finance-workflow-detail__decision-card-footer">
                  <div className="finance-workflow-detail__decision-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn--compact"
                      onClick={() => void handleApprovePoFinance()}
                    >
                      Approve PO
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn--compact finance-home__btn-reject"
                      onClick={() => {
                        setRejectPoFinanceNote('')
                        setShowRejectPoFinance(true)
                      }}
                    >
                      Reject…
                    </button>
                  </div>
                  <div
                    className="finance-workflow-detail__doc-tools finance-workflow-detail__doc-tools--decision"
                    role="group"
                    aria-label="Customer PO document"
                  >
                    <span className="finance-workflow-detail__doc-kind">Customer PO file</span>
                    {record.po ? (
                      <>
                        <button
                          type="button"
                          className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
                          onClick={() => openCustomerPoPreview()}
                          aria-label="Preview customer PO"
                          title="Preview customer PO"
                        >
                          <DocEyeIcon className="finance-home__btn-preview-attachment-icon" />
                        </button>
                        <button
                          type="button"
                          className="finance-home__btn-preview-attachment finance-workflow-detail__doc-icon-btn"
                          onClick={() => {
                            const po = record.po
                            if (!po) return
                            downloadBlob(
                              quotePoBlob(po),
                              safeAttachmentDownloadFilename(po.fileName || '', 'customer-po.pdf'),
                            )
                          }}
                          aria-label="Download customer PO"
                          title="Download customer PO"
                        >
                          <DocDownloadIcon className="finance-home__btn-preview-attachment-icon" />
                        </button>
                      </>
                    ) : (
                      <span className="muted finance-workflow-detail__doc-missing">No file attached</span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
            {ovfFinPending ? (
              <div className="finance-workflow-detail__decision-card">
                <h3 className="finance-workflow-detail__h3">Order verification (OVF)</h3>
                <p className="finance-workflow-detail__decision-desc muted">
                  Approve for SCM handoff; Sales will no longer edit this OVF.
                </p>
                <div className="finance-workflow-detail__decision-card-footer">
                  <div className="finance-workflow-detail__decision-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn--compact"
                      onClick={() => void handleApproveOvf()}
                    >
                      Approve OVF
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn--compact finance-home__btn-reject"
                      onClick={() => {
                        setRejectOvfNote('')
                        setShowRejectOvf(true)
                      }}
                    >
                      Reject…
                    </button>
                  </div>
                  <OvfWorkflowDocTools
                    quoteRecordId={record.id}
                    record={record}
                    docKindLabel="OVF file"
                    layout="decision"
                  />
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="finance-workflow-detail__section" aria-labelledby="wf-timeline-heading">
        <h2 id="wf-timeline-heading" className="finance-workflow-detail__h2">
          Timeline
        </h2>
        {timeline.length === 0 ? (
          <p className="muted">No dated workflow steps recorded yet.</p>
        ) : (
          <ol className="finance-workflow-detail__timeline">
            {timeline.map((row, i) => (
              <li key={`${row.iso}-${row.title}-${i}`} className="finance-workflow-detail__timeline-item">
                <time className="finance-workflow-detail__time" dateTime={row.iso}>
                  {formatTs(row.iso)}
                </time>
                <div className="finance-workflow-detail__timeline-body">
                  <strong className="finance-workflow-detail__timeline-title">{row.title}</strong>
                  {row.detail ? <p className="finance-workflow-detail__timeline-detail muted">{row.detail}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {quotePreviewOpen ? (
        <div
          className="modal-backdrop finance-home-quote-preview-backdrop"
          role="presentation"
          onMouseDown={() => setQuotePreviewOpen(false)}
        >
          <div
            className="modal-card finance-home-quote-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-quote-preview-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="finance-home-quote-preview-modal__head">
              <h3 id="wf-quote-preview-title" className="modal-card__title">
                Quote {record.quoteRef}
              </h3>
              <div className="finance-home-quote-preview-modal__head-actions">
                <button
                  type="button"
                  className="finance-home__btn-preview-attachment finance-home-quote-preview-modal__pdf-btn"
                  onClick={() => void downloadQuotePdf()}
                  disabled={quotePdfDownloading}
                  title="Download quote PDF"
                  aria-label="Download quote PDF"
                >
                  <DocDownloadIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn--compact"
                  onClick={() => setQuotePreviewOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <p className="muted finance-home-quote-preview-modal__lead">
              Customer-facing quote preview — same as the PDF download.
            </p>
            <div className="finance-home-quote-preview-modal__body pdf-preview pdf-preview--html">
              <QuoteHtmlPreview
                data={normalizeQuoteFormData(
                  record.formSnapshot as QuoteFormData & { customerTitle?: string },
                )}
              />
            </div>
          </div>
        </div>
      ) : null}

      {invoiceAttachmentPreview &&
      invoiceAttachmentPreviewUrl &&
      invoiceAttachmentPreviewMode ? (
        <div
          className="modal-backdrop finance-home-attachment-preview-backdrop"
          role="presentation"
          onMouseDown={() => setInvoiceAttachmentPreview(null)}
        >
          <div
            className="modal-card finance-home-attachment-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-invoice-preview-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="finance-home-attachment-preview-modal__head">
              <div>
                <h3 id="wf-invoice-preview-title" className="modal-card__title">
                  {invoiceAttachmentPreview.title}
                </h3>
                <p className="finance-home-attachment-preview-modal__file muted">
                  {invoiceAttachmentPreview.fileLabel}
                </p>
              </div>
              <div className="finance-home-attachment-preview-modal__head-actions">
                <button
                  type="button"
                  className="finance-home__btn-preview-attachment finance-home-attachment-preview-modal__download-btn"
                  onClick={() =>
                    downloadBlob(
                      invoiceAttachmentPreview.blob,
                      invoiceAttachmentPreview.downloadFilename,
                    )
                  }
                  title="Download file"
                  aria-label="Download file"
                >
                  <DocDownloadIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn--compact"
                  onClick={() => setInvoiceAttachmentPreview(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="finance-home-attachment-preview-modal__body">
              {invoiceAttachmentPreviewMode === 'pdf' ? (
                <iframe
                  className="finance-home-attachment-preview-modal__frame"
                  title={invoiceAttachmentPreview.fileLabel}
                  src={invoiceAttachmentPreviewUrl}
                />
              ) : null}
              {invoiceAttachmentPreviewMode === 'image' ? (
                <div className="finance-home-attachment-preview-modal__img-wrap">
                  <img
                    className="finance-home-attachment-preview-modal__img"
                    src={invoiceAttachmentPreviewUrl}
                    alt=""
                  />
                </div>
              ) : null}
              {invoiceAttachmentPreviewMode === 'unsupported' ? (
                invoiceAttachmentSpreadsheetKind ? (
                  <div className="finance-home-attachment-preview-modal__sheet-panel">
                    <p className="finance-home-attachment-preview-modal__sheet-lead muted">
                      {invoiceAttachmentSpreadsheetKind === 'csv'
                        ? 'CSV files cannot be previewed here. Save the file, then open it from the folder you choose — it will usually open in Microsoft Excel on this PC if Excel is installed.'
                        : 'Excel workbooks cannot be previewed in the browser. Save the file, then open it from the folder you choose — Windows normally opens .xlsx files in Excel automatically.'}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary finance-home-attachment-preview-modal__sheet-btn"
                      onClick={() =>
                        void saveBlobForDesktopOpen(
                          invoiceAttachmentPreview.blob,
                          invoiceAttachmentPreview.downloadFilename,
                        )
                      }
                    >
                      Save to open in Excel…
                    </button>
                    <p className="finance-home-attachment-preview-modal__sheet-hint muted">
                      Tip: if your browser does not ask where to save, use the download icon above —
                      then open the file from your Downloads folder.
                    </p>
                  </div>
                ) : (
                  <p className="finance-home-attachment-preview-modal__fallback muted">
                    This file type cannot be shown in the browser. Use Download to open it on your
                    device.
                  </p>
                )
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {showRejectQuoteFinance && record.quoteFinanceReview ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setShowRejectQuoteFinance(false)
            setRejectQuoteFinanceNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-reject-quote-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="wf-reject-quote-title" className="modal-card__title">
              Reject quote {record.quoteRef}
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
                  setShowRejectQuoteFinance(false)
                  setRejectQuoteFinanceNote('')
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmRejectQuoteFinance()}>
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRejectPoFinance && record.poFinanceReview ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setShowRejectPoFinance(false)
            setRejectPoFinanceNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-reject-po-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="wf-reject-po-title" className="modal-card__title">
              Reject customer PO — {record.quoteRef}
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
                  setShowRejectPoFinance(false)
                  setRejectPoFinanceNote('')
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmRejectPoFinance()}>
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRejectOvf && record.ovf ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            setShowRejectOvf(false)
            setRejectOvfNote('')
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-reject-ovf-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="wf-reject-ovf-title" className="modal-card__title">
              Reject {record.ovf.ovfRef}
            </h3>
            <label className="field modal-card__field">
              <span className="field__label">Reason (shown to Sales)</span>
              <textarea
                className="field__control"
                rows={3}
                value={rejectOvfNote}
                onChange={(e) => setRejectOvfNote(e.target.value)}
              />
            </label>
            <div className="modal-card__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setShowRejectOvf(false)
                  setRejectOvfNote('')
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmRejectOvf()}>
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
