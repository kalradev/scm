import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { SalesOvfPreviewModal } from '../components/SalesOvfPreviewModal'
import { ShareQuoteOutlookModal } from '../components/ShareQuoteOutlookModal'
import { QuoteDetailsPreviewModal } from './QuotePoPage'
import { useAuth } from '../context/useAuth'
import { downloadBlob, downloadQuoteCsvFromForm } from '../lib/quoteExport'
import { hasCustomerPoUploaded } from '../lib/quotePoMatch'
import {
  computeQuoteFinanceReviewExtras,
  enrichQuoteFormWithVendorAttachment,
} from '../lib/enrichQuoteVendorRates'
import { quoteFinanceEconomics } from '../lib/quoteFinanceEconomics'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { buildQuoteTwoPagePdf } from '../lib/quotePdfTemplate'
import type { QuoteFormData } from '../types/quotePdf'
import { effectiveOvfWorkflow } from '../lib/ovfWorkflow'
import {
  canSalesAccessCustomerPoStep,
  canSalesCreateOvf,
  effectivePoFinanceStatus,
  effectiveQuoteFinanceStatus,
  invoicePipelineNoticeForSales,
  isSalesFinanceRejectedQuote,
  salesEyePreviewPrefersOvf,
  salesOvfWorkflowAfterPoGate,
  usesInvoiceQuotePipeline,
} from '../lib/quotePipeline'
import {
  deleteDraftForUser,
  isQuoteDraft,
  listSavedQuotesForUser,
  mergeQuoteFinanceReviewOnRecord,
  SAVED_QUOTES_LOCAL_STORAGE_KEY,
  SAVED_QUOTES_UPDATED_EVENT,
  setCustomerQuoteShipmentOnRecord,
  submitMatchedPoToFinanceForRecord,
  updateSavedQuoteFormSnapshotByRecordId,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import { formatQuoteDateDisplay } from '../lib/senderAddresses'
import shareIconPng from '../assets/share-icon.png'

type SalesQuoteListFilter = 'all' | 'finals' | 'poMatched' | 'rejected'

function quoteStats(rows: SavedQuoteRecord[]) {
  let drafts = 0
  let finals = 0
  let poMatched = 0
  let rejected = 0
  for (const row of rows) {
    if (isQuoteDraft(row)) {
      drafts += 1
      continue
    }
    finals += 1
    if (isSalesFinanceRejectedQuote(row)) rejected += 1
    if (hasCustomerPoUploaded(row.po)) poMatched += 1
  }
  return { drafts, finals, poMatched, rejected, total: finals }
}

async function downloadQuotePdf(record: SavedQuoteRecord) {
  if (isQuoteDraft(record)) return
  const safe = record.quoteRef.replace(/[^\w.-]+/g, '_') || 'quote'
  const blob = await buildQuoteTwoPagePdf(record.formSnapshot)
  downloadBlob(blob, `${safe}.pdf`)
}


const DELETE_DRAFT_NOTICE =
  'Delete this draft permanently?\n\nThis cannot be undone. Other drafts and finalized quotes are not affected.'

function SalesStatIcon({
  name,
}: {
  name: 'total' | 'draft' | 'final' | 'match' | 'rejected'
}) {
  const p = {
    className: 'sales-dashboard__stat-icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'total':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m0-12.75V3m0 12.75V18m-9-1.5h.008v.008H9.75v-.008zm0-3.75h.008v.008H9.75V9zm0-3.75h.008v.008H9.75v-.008zm0-3.75h.008v.008H9.75V2.25z"
          />
        </svg>
      )
    case 'draft':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
          />
        </svg>
      )
    case 'final':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )
    case 'match':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622.621-.621A4.5 4.5 0 0017.218 4.5l-4.5 4.5a4.5 4.5 0 01-6.364 0l-.621-.621m-2.485-2.484l-.621-.621A4.5 4.5 0 004.5 8.25l4.5 4.5a4.5 4.5 0 006.364 0l.621-.621"
          />
        </svg>
      )
    case 'rejected':
      return (
        <svg {...p}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )
    default:
      return null
  }
}

type EyePreviewOpen =
  | { kind: 'po'; quoteId: string }
  | { kind: 'ovf'; quoteId: string }

const DOWNLOAD_PANEL_MIN_W = 168

function IconEye() {
  return (
    <svg
      className="sales-dashboard__action-icon"
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
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  )
}

function IconDownload() {
  return (
    <svg
      className="sales-dashboard__action-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
      />
    </svg>
  )
}

function eyePreviewKind(row: SavedQuoteRecord): EyePreviewOpen['kind'] {
  return salesEyePreviewPrefersOvf(row) ? 'ovf' : 'po'
}

function QuotePipelineStatus({
  row,
  hasPoUploaded,
  onRecordMutated,
}: {
  row: SavedQuoteRecord
  hasPoUploaded: boolean
  onRecordMutated: () => void
}) {
  const { user } = useAuth()
  const wf = effectiveOvfWorkflow(row.ovf)
  const hasOvf = Boolean(row.ovf)
  const invoicePath = usesInvoiceQuotePipeline(row)
  const invoiceQs = effectiveQuoteFinanceStatus(row)
  const poFinance = invoicePath ? effectivePoFinanceStatus(row) : ('none' as const)
  const quoteAwaitingFinance = invoiceQs === 'pending_finance'
  const sentToBuyer = Boolean(row.customerQuoteShipment?.sentToCustomerAt)
  const canPoPage = invoicePath ? canSalesAccessCustomerPoStep(row) : true
  const showUploadPoCta =
    !hasPoUploaded &&
    canPoPage &&
    // After PO is submitted to Finance for GST review, Sales should not keep seeing "Upload PO".
    !(invoicePath && poFinance === 'pending_finance') &&
    // After Finance approves the PO, next step is OVF — not another PO upload.
    !(invoicePath && poFinance === 'finance_approved')
  const showSentToCustomerCta =
    invoicePath &&
    invoiceQs === 'finance_approved' &&
    !sentToBuyer &&
    !quoteAwaitingFinance
  const ovfGateOpen = canSalesCreateOvf(row)
  const showOvfLink =
    ovfGateOpen &&
    (!hasOvf || wf === 'sales_draft' || wf === 'finance_rejected')
  /** Same gate as Quote PO page — send matched customer PO to Finance for GST before OVF unlocks. */
  const showSubmitPoToFinanceCta =
    invoicePath &&
    Boolean(user) &&
    hasPoUploaded &&
    Boolean(row.po) &&
    (poFinance === 'none' || poFinance === 'finance_rejected') &&
    invoiceQs === 'finance_approved' &&
    sentToBuyer

  return (
    <div className="sales-dashboard__status-stack">
      {invoiceQs === 'finance_rejected' ? (
        <span className="sales-dashboard__pipeline-hint sales-dashboard__pipeline-hint--warn">
          Quote rejected
        </span>
      ) : null}
      {hasOvf && wf === 'pending_finance' ? (
        <span className="muted sales-dashboard__pipeline-hint">
          Sent to Finance
        </span>
      ) : null}
      {hasOvf && wf === 'finance_approved' ? (
        <span className="muted sales-dashboard__pipeline-hint">
          Approved (SCM)
        </span>
      ) : null}
      {invoicePath && poFinance === 'pending_finance' ? (
        <span
          className="muted sales-dashboard__pipeline-hint"
          title="Customer PO is submitted to Finance for GST verification."
        >
          Awaiting GST check (Finance)
        </span>
      ) : null}
      {invoicePath &&
      poFinance === 'pending_finance' &&
      hasPoUploaded ? (
        <span
          className="muted sales-dashboard__pipeline-hint"
          title="Finance is reviewing the customer PO (GST and line checks). You can create the OVF after they approve."
        >
          Waiting for Finance approval
        </span>
      ) : null}
      {invoicePath &&
      poFinance === 'finance_rejected' &&
      hasPoUploaded ? (
        <span className="sales-dashboard__pipeline-hint sales-dashboard__pipeline-hint--warn">
          PO rejected
        </span>
      ) : null}
      {invoicePath &&
      invoiceQs === 'finance_approved' &&
      sentToBuyer &&
      poFinance === 'none' &&
      hasPoUploaded &&
      row.po &&
      !showSubmitPoToFinanceCta ? (
        <span className="muted sales-dashboard__pipeline-hint">Submit PO in PO tab</span>
      ) : null}
      {invoicePath && quoteAwaitingFinance && !hasPoUploaded ? (
        <span className="muted sales-dashboard__pipeline-hint">Awaiting Finance</span>
      ) : null}
      {showUploadPoCta ? (
        <Link
          to={`/sales/q/${row.id}`}
          className={`btn btn-ghost btn--compact sales-dashboard__action-primary sales-dashboard__po-upload sales-dashboard__status-action-btn${quoteAwaitingFinance ? ' muted' : ''}`}
          aria-disabled={quoteAwaitingFinance}
          title={
            quoteAwaitingFinance ? 'Finance is reviewing quote + invoice' : 'Upload PO'
          }
          tabIndex={quoteAwaitingFinance ? -1 : undefined}
          onClick={(e) => {
            if (quoteAwaitingFinance) {
              e.preventDefault()
            }
          }}
        >
          Upload PO
        </Link>
      ) : null}
      {showSentToCustomerCta ? (
        <button
          type="button"
          className="btn btn-primary btn--compact sales-dashboard__action-primary sales-dashboard__status-action-btn sales-dashboard__sent-customer-btn"
          title="Mark that the quotation PDF was emailed to the customer"
          onClick={() => {
            if (
              !user ||
              !window.confirm(
                'Mark this quotation as sent to the customer? You will then unlock customer PO upload.',
              )
            ) {
              return
            }
            const next = setCustomerQuoteShipmentOnRecord(row.id, user.oid, {
              sentToCustomerAt: new Date().toISOString(),
            })
            if (next) {
              onRecordMutated()
            }
          }}
        >
          Sent to customer
        </button>
      ) : null}
      {showSubmitPoToFinanceCta ? (
        <button
          type="button"
          className="btn btn-primary btn--compact sales-dashboard__action-primary sales-dashboard__status-action-btn"
          title="Send the customer PO to Finance for GST and line checks. OVF unlocks after approval."
          onClick={() => {
            if (!user) return
            const next = submitMatchedPoToFinanceForRecord(row.id)
            if (next) {
              onRecordMutated()
              return
            }
            window.alert(
              'Could not submit to Finance. Open the PO tab and upload the customer PO first.',
            )
          }}
        >
          Submit PO to Finance
        </button>
      ) : null}
      {showOvfLink ? (
        <Link
          to={`/sales/q/${row.id}/ovf`}
          className={`btn btn-primary btn--compact sales-dashboard__status-action-btn${showSentToCustomerCta ? '' : ' sales-dashboard__action-primary'}`}
          title={
            wf === 'finance_rejected'
              ? 'Update OVF and send to Finance again'
              : 'Create or edit OVF — prefilled from quote, vendor invoice, and customer PO'
          }
        >
          OVF
        </Link>
      ) : null}
    </div>
  )
}

function QuoteDownloadMenu({
  row,
  formSnap,
}: {
  row: SavedQuoteRecord
  formSnap: QuoteFormData & { customerTitle?: string }
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = rect.left
    left = Math.max(
      8,
      Math.min(left, window.innerWidth - DOWNLOAD_PANEL_MIN_W - 8),
    )
    setPos({ top: rect.bottom + 6, left })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    updatePosition()
    const onScrollOrResize = () => updatePosition()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function handleDownloadBoth() {
    await downloadQuotePdf(row)
    await new Promise((r) => setTimeout(r, 200))
    downloadQuoteCsvFromForm(formSnap)
  }

  function closeAnd(fn: () => void) {
    setOpen(false)
    fn()
  }

  return (
    <div className="sales-dashboard__download-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="sales-dashboard__icon-btn"
        aria-label="Download options"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Download"
        onClick={() => setOpen(true)}
      >
        <IconDownload />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="sales-dashboard__download-menu-panel sales-dashboard__download-menu-panel--portal"
            style={{ top: pos.top, left: pos.left }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              className="sales-dashboard__download-menu-item"
              onClick={() =>
                closeAnd(() => {
                  void downloadQuotePdf(row)
                })
              }
            >
              PDF
            </button>
            <button
              type="button"
              role="menuitem"
              className="sales-dashboard__download-menu-item"
              onClick={() =>
                closeAnd(() => {
                  downloadQuoteCsvFromForm(formSnap)
                })
              }
            >
              CSV
            </button>
            <button
              type="button"
              role="menuitem"
              className="sales-dashboard__download-menu-item"
              onClick={() =>
                closeAnd(() => {
                  void handleDownloadBoth()
                })
              }
            >
              PDF + CSV
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

function QuoteMoreMenu({
  row,
  formSnap,
  onOpenShare,
  onOpenEyePreview,
}: {
  row: SavedQuoteRecord
  formSnap: QuoteFormData & { customerTitle?: string }
  onOpenShare: () => void
  onOpenEyePreview: (open: EyePreviewOpen) => void
}) {
  const { user } = useAuth()
  const previewOvf = salesEyePreviewPrefersOvf(row)
  const viewTitle = previewOvf ? 'View OVF as read-only form' : 'View quote details'

  const showDownloads = user?.role !== 'sales'

  return (
    <div className="sales-dashboard__overflow-wrap sales-dashboard__menu-tray">
      <button
        type="button"
        className="sales-dashboard__icon-btn"
        title={viewTitle}
        aria-label={viewTitle}
        onClick={() =>
          onOpenEyePreview(
            eyePreviewKind(row) === 'ovf'
              ? { kind: 'ovf', quoteId: row.id }
              : { kind: 'po', quoteId: row.id },
          )
        }
      >
        <IconEye />
      </button>
      <button
        type="button"
        className="sales-dashboard__icon-btn sales-dashboard__icon-btn--share"
        title="Share with Outlook"
        aria-label="Share quote"
        onClick={() => onOpenShare()}
      >
        <img
          src={shareIconPng}
          alt=""
          className="sales-dashboard__action-icon sales-dashboard__action-icon--png"
          width={18}
          height={18}
          decoding="async"
        />
      </button>
      {showDownloads ? <QuoteDownloadMenu row={row} formSnap={formSnap} /> : null}
    </div>
  )
}

function FinalizedQuoteRowCells({
  row,
  hasPoUploaded,
  onOpenShare,
  onOpenEyePreview,
  onRecordMutated,
}: {
  row: SavedQuoteRecord
  hasPoUploaded: boolean
  onOpenShare: () => void
  onOpenEyePreview: (open: EyePreviewOpen) => void
  onRecordMutated: () => void
}) {
  const formSnap = row.formSnapshot as QuoteFormData & { customerTitle?: string }
  return (
    <>
      <td className="sales-dashboard__table-col--status">
        <QuotePipelineStatus
          row={row}
          hasPoUploaded={hasPoUploaded}
          onRecordMutated={onRecordMutated}
        />
      </td>
      <td className="sales-dashboard__table-col--menu">
        <QuoteMoreMenu
          row={row}
          formSnap={formSnap}
          onOpenShare={onOpenShare}
          onOpenEyePreview={onOpenEyePreview}
        />
      </td>
    </>
  )
}

function wfPillClass(state: 'upcoming' | 'current' | 'done'): string {
  return `sales-dashboard__wf-pill sales-dashboard__wf-pill--${state}`
}

type WfPill = {
  key: string
  state: 'upcoming' | 'current' | 'done'
  label: string
  warn?: boolean
}

/** PO not uploaded yet: show pipeline before OVF. */
function QuotePoGateWorkflowRow({ row }: { row: SavedQuoteRecord }) {
  const hasPo = hasCustomerPoUploaded(row.po)
  const invoicePath = usesInvoiceQuotePipeline(row)
  const qs = effectiveQuoteFinanceStatus(row)
  const ps = invoicePath ? effectivePoFinanceStatus(row) : ('none' as const)
  const sent = Boolean(row.customerQuoteShipment?.sentToCustomerAt)
  const canPo = canSalesAccessCustomerPoStep(row)
  const poBlocked = invoicePath && !canPo

  const pills: WfPill[] = [{ key: 'quote', state: 'done', label: 'Quote final' }]

  if (invoicePath) {
    if (qs === 'pending_finance') {
      pills.push({ key: 'qfin', state: 'current', label: 'Finance · quote' })
    } else if (qs === 'finance_rejected') {
      pills.push({ key: 'qfin', state: 'current', label: 'Finance · rejected', warn: true })
    } else if (qs === 'finance_approved') {
      pills.push({ key: 'qfin', state: 'done', label: 'Finance · approved' })
    } else {
      pills.push({ key: 'qfin', state: 'upcoming', label: 'Finance · quote' })
    }

    if (qs !== 'finance_approved') {
      pills.push({ key: 'sent', state: 'upcoming', label: 'Sent to customer' })
    } else if (!sent) {
      pills.push({ key: 'sent', state: 'current', label: 'Sent to customer' })
    } else {
      pills.push({ key: 'sent', state: 'done', label: 'Sent to customer' })
    }
  }

  if (poBlocked) {
    pills.push({ key: 'po', state: 'upcoming', label: 'PO · upload' })
  } else if (invoicePath && ps === 'pending_finance') {
    pills.push({ key: 'po', state: 'current', label: 'PO · awaiting GST check' })
  } else if (invoicePath && ps === 'finance_rejected') {
    pills.push({ key: 'po', state: 'current', label: 'PO · rejected', warn: true })
  } else if (invoicePath && ps === 'finance_approved') {
    pills.push({ key: 'po', state: 'done', label: 'PO · approved' })
  } else {
    const poLabel = hasPo ? 'PO · uploaded' : 'PO · awaiting upload'
    pills.push({ key: 'po', state: 'current', label: poLabel })
  }

  pills.push(
    { key: 'ovf', state: 'upcoming', label: 'OVF' },
    { key: 'fin', state: 'upcoming', label: 'Finance' },
    { key: 'scm', state: 'upcoming', label: 'SCM' },
  )

  return (
    <tr className="sales-dashboard__wf-row">
      <td colSpan={6}>
        <div className="sales-dashboard__wf-inner">
          {pills.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 ? (
                <span className="sales-dashboard__wf-arrow" aria-hidden>
                  →
                </span>
              ) : null}
              <span
                className={`${wfPillClass(p.state)}${
                  p.warn ? ' sales-dashboard__wf-pill--warn' : ''
                }`}
              >
                {p.label}
              </span>
            </Fragment>
          ))}
        </div>
      </td>
    </tr>
  )
}

/** Second table row: full OVF / finance / SCM when PO gate cleared; otherwise PO gate. */
function QuoteSalesWorkflowRow({ row }: { row: SavedQuoteRecord }) {
  if (salesOvfWorkflowAfterPoGate(row)) {
    return <QuoteOvfWorkflowRow row={row} />
  }
  return <QuotePoGateWorkflowRow row={row} />
}

/**
 * When PO totals match, this row used to show only OVF → Finance → SCM, so the invoice
 * path (Finance · quote, Sent to customer) and the PO step vanished. We keep the same
 * preamble as `QuotePoGateWorkflowRow`, then PO · matched, then the OVF commercial pipeline.
 */
function QuoteOvfWorkflowRow({ row }: { row: SavedQuoteRecord }) {
  const wf = effectiveOvfWorkflow(row.ovf)
  const hasOvf = Boolean(row.ovf)
  const invoicePath = usesInvoiceQuotePipeline(row)
  const qs = effectiveQuoteFinanceStatus(row)
  const sent = Boolean(row.customerQuoteShipment?.sentToCustomerAt)
  const poFinanceSt = invoicePath ? effectivePoFinanceStatus(row) : 'none'
  const poStepDoneLabel =
    hasCustomerPoUploaded(row.po)
      ? 'PO · uploaded'
      : invoicePath && poFinanceSt === 'finance_approved'
        ? 'PO · approved'
        : 'PO · uploaded'

  const pills: WfPill[] = [{ key: 'quote', state: 'done', label: 'Quote final' }]

  if (invoicePath) {
    if (qs === 'pending_finance') {
      pills.push({ key: 'qfin', state: 'current', label: 'Finance · quote' })
    } else if (qs === 'finance_rejected') {
      pills.push({ key: 'qfin', state: 'current', label: 'Finance · rejected', warn: true })
    } else if (qs === 'finance_approved') {
      pills.push({ key: 'qfin', state: 'done', label: 'Finance · approved' })
    } else {
      pills.push({ key: 'qfin', state: 'upcoming', label: 'Finance · quote' })
    }

    if (qs !== 'finance_approved') {
      pills.push({ key: 'sent', state: 'upcoming', label: 'Sent to customer' })
    } else if (!sent) {
      pills.push({ key: 'sent', state: 'current', label: 'Sent to customer' })
    } else {
      pills.push({ key: 'sent', state: 'done', label: 'Sent to customer' })
    }
  }

  pills.push({ key: 'po_ok', state: 'done', label: poStepDoneLabel })

  let ovfState: 'upcoming' | 'current' | 'done' = 'upcoming'
  let ovfLabel = 'OVF'
  if (!hasOvf) {
    ovfState = 'current'
    ovfLabel = 'OVF (not started)'
  } else if (wf === 'sales_draft') {
    ovfState = 'current'
    ovfLabel = 'OVF draft'
  } else if (wf === 'finance_rejected') {
    ovfState = 'current'
    ovfLabel = 'OVF (revise)'
  } else {
    ovfState = 'done'
    ovfLabel = 'OVF submitted'
  }
  pills.push({ key: 'ovf', state: ovfState, label: ovfLabel })

  let financeState: 'upcoming' | 'current' | 'done' = 'upcoming'
  let financeLabel = 'Finance'
  if (!hasOvf || wf === 'sales_draft') {
    financeState = 'upcoming'
    financeLabel = 'Finance'
  } else if (wf === 'pending_finance') {
    financeState = 'current'
    financeLabel = 'Finance · reviewing'
  } else if (wf === 'finance_rejected') {
    financeState = 'current'
    financeLabel = 'Finance · rejected'
  } else if (wf === 'finance_approved') {
    financeState = 'done'
    financeLabel = 'Finance · approved'
  }
  pills.push({
    key: 'ovf_finance',
    state: financeState,
    label: financeLabel,
    warn: wf === 'finance_rejected',
  })

  const scmDone = wf === 'finance_approved'
  const scmState: 'upcoming' | 'current' | 'done' = scmDone ? 'done' : 'upcoming'
  const scmLabel = scmDone ? 'SCM handoff' : 'SCM'
  pills.push({ key: 'scm', state: scmState, label: scmLabel })

  return (
    <tr className="sales-dashboard__wf-row">
      <td colSpan={6}>
        <div className="sales-dashboard__wf-inner">
          {pills.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 ? (
                <span className="sales-dashboard__wf-arrow" aria-hidden>
                  →
                </span>
              ) : null}
              <span
                className={`${wfPillClass(p.state)}${
                  p.warn ? ' sales-dashboard__wf-pill--warn' : ''
                }`}
              >
                {p.label}
              </span>
            </Fragment>
          ))}
        </div>
      </td>
    </tr>
  )
}

type SalesQuoteTableRowGroupProps = {
  row: SavedQuoteRecord
  onDeleteDraft: (row: SavedQuoteRecord) => void
  onOpenShare: (row: SavedQuoteRecord) => void
  onOpenEyePreview: (open: EyePreviewOpen) => void
  refreshList: () => void
}

/** Main quote row + optional OVF workflow row (Fragment keeps valid `<tbody>` structure). */
function SalesQuoteTableRowGroup({
  row,
  onDeleteDraft,
  onOpenShare,
  onOpenEyePreview,
  refreshList,
}: SalesQuoteTableRowGroupProps) {
  const form = normalizeQuoteFormData(
    row.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const hasPoUploaded = !isQuoteDraft(row) && hasCustomerPoUploaded(row.po)

  return (
    <Fragment>
      <tr
        className={
          salesOvfWorkflowAfterPoGate(row) ? 'sales-dashboard__row--po-match' : ''
        }
      >
        <td>
          {isQuoteDraft(row) ? (
            <span className="sales-dashboard__draft-no-label">Draft</span>
          ) : (
            <span className="sales-dashboard__quote-ref">{row.quoteRef}</span>
          )}
        </td>
        <td>{form.customerName.trim() || '—'}</td>
        <td>{formatQuoteDateDisplay(row.formSnapshot.quoteDate)}</td>
        <td className="sales-dashboard__table-col--po-match">
          {isQuoteDraft(row) ? (
            <span className="muted">—</span>
          ) : (
            <div className="sales-dashboard__po-match-cell">
              <div className="sales-dashboard__po-match-label-row">
                {hasPoUploaded ? (
                  <span className="sales-dashboard__badge-match">Uploaded</span>
                ) : usesInvoiceQuotePipeline(row) &&
                  effectivePoFinanceStatus(row) === 'finance_approved' ? (
                  <span
                    className="sales-dashboard__badge-match"
                    title="Customer PO approved by Finance (GST and line checks)"
                  >
                    Approved
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </div>
            </div>
          )}
        </td>
        {isQuoteDraft(row) ? (
          <td colSpan={2}>
            <div className="sales-dashboard__row-actions">
              <Link
                to={`/sales/quote/new?draft=${row.id}`}
                className="btn btn-ghost btn--compact"
              >
                Continue
              </Link>
              <button
                type="button"
                className="btn btn-ghost btn--compact sales-dashboard__delete-draft"
                onClick={() => onDeleteDraft(row)}
              >
                Delete draft
              </button>
            </div>
          </td>
        ) : (
          <FinalizedQuoteRowCells
            row={row}
            hasPoUploaded={hasPoUploaded}
            onOpenShare={() => onOpenShare(row)}
            onOpenEyePreview={onOpenEyePreview}
            onRecordMutated={() => refreshList()}
          />
        )}
      </tr>
      {!isQuoteDraft(row) && invoicePipelineNoticeForSales(row)?.trim() ? (
        <tr className="sales-dashboard__wf-row sales-dashboard__wf-row--notice">
          <td colSpan={6}>
            <p className="sales-dashboard__pipeline-msg muted" role="status">
              {invoicePipelineNoticeForSales(row)}
            </p>
          </td>
        </tr>
      ) : null}
      {!isQuoteDraft(row) ? <QuoteSalesWorkflowRow row={row} /> : null}
    </Fragment>
  )
}

export function SalesHome() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [listVersion, setListVersion] = useState(0)
  const [financeQueueBanner, setFinanceQueueBanner] = useState<string | null>(
    null,
  )
  const [shareTarget, setShareTarget] = useState<SavedQuoteRecord | null>(null)
  const [eyeModal, setEyeModal] = useState<EyePreviewOpen | null>(null)
  const [quoteListFilter, setQuoteListFilter] = useState<SalesQuoteListFilter>('all')
  const [invoiceDragOver, setInvoiceDragOver] = useState(false)

  const onInvoiceDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setInvoiceDragOver(false)
      const file = e.dataTransfer.files?.[0] ?? null
      if (!file) return
      navigate('/sales/quote/from-invoice', {
        state: { pendingInvoiceFile: file },
      })
    },
    [navigate],
  )

  const savedQuotes = useMemo(() => {
    if (!user) return []
    return listSavedQuotesForUser(user.oid)
  }, [user, listVersion])

  const displayedQuotes = useMemo(() => {
    const finalized = savedQuotes.filter((r) => !isQuoteDraft(r))
    if (quoteListFilter === 'all') return finalized
    if (quoteListFilter === 'finals') return finalized
    if (quoteListFilter === 'rejected') {
      return finalized.filter(isSalesFinanceRejectedQuote)
    }
    return finalized.filter((r) => hasCustomerPoUploaded(r.po))
  }, [savedQuotes, quoteListFilter])

  const finalizedCount = useMemo(
    () => savedQuotes.filter((r) => !isQuoteDraft(r)).length,
    [savedQuotes],
  )

  const stats = useMemo(() => quoteStats(savedQuotes), [savedQuotes])

  const refreshList = useCallback(() => {
    setListVersion((v) => v + 1)
  }, [])

  /** Keep dashboard in sync when Finance (or another tab) updates the same local quote storage. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_QUOTES_LOCAL_STORAGE_KEY) refreshList()
    }
    const onUpdated = () => refreshList()
    window.addEventListener('storage', onStorage)
    window.addEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SAVED_QUOTES_UPDATED_EVENT, onUpdated)
    }
  }, [refreshList])

  /** Re-parse attached supplier invoices to fill vendor unit rates on quotes pending Finance. */
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void (async () => {
      const quotes = listSavedQuotesForUser(user.oid)
      let changed = false
      for (const row of quotes) {
        if (cancelled) break
        if (isQuoteDraft(row)) continue
        if (effectiveQuoteFinanceStatus(row) !== 'pending_finance') continue
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
      if (changed && !cancelled) refreshList()
    })()
    return () => {
      cancelled = true
    }
  }, [user, listVersion, refreshList])

  useEffect(() => {
    const qref = (
      location.state as { quoteSubmittedForFinanceReview?: string } | null
    )?.quoteSubmittedForFinanceReview?.trim()
    if (!qref) return
    setFinanceQueueBanner(
      `Quote ${qref} was sent to Finance with the vendor invoice. Switch to the Finance workspace to review it. You can still preview or download the PDF from this list while it is pending.`,
    )
    navigate('.', { replace: true, state: {} })
  }, [location.state, navigate])

  const handleDeleteDraft = useCallback(
    (row: SavedQuoteRecord) => {
      if (!user || !isQuoteDraft(row)) return
      if (!window.confirm(DELETE_DRAFT_NOTICE)) return
      if (deleteDraftForUser(row.id, user.oid)) {
        refreshList()
      }
    },
    [user, refreshList],
  )

  return (
    <section className="panel sales-dashboard">
      {shareTarget ? (
        <ShareQuoteOutlookModal
          record={shareTarget}
          onClose={() => setShareTarget(null)}
        />
      ) : null}
      {eyeModal?.kind === 'po' ? (
        <QuoteDetailsPreviewModal
          quoteId={eyeModal.quoteId}
          onClose={() => setEyeModal(null)}
        />
      ) : null}
      {eyeModal?.kind === 'ovf' ? (
        <SalesOvfPreviewModal
          quoteId={eyeModal.quoteId}
          onClose={() => setEyeModal(null)}
        />
      ) : null}
      <header className="sales-dashboard__hero">
        <div className="sales-dashboard__hero-text">
          <h2 className="sales-dashboard__title">Quotes &amp; OVF</h2>
        </div>
      </header>

      {financeQueueBanner ? (
        <div
          className="sales-dashboard__banner sales-dashboard__banner--info"
          role="status"
        >
          <span>{financeQueueBanner}</span>
          <button
            type="button"
            className="btn btn-ghost btn--compact"
            onClick={() => setFinanceQueueBanner(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="sales-dashboard__stats" role="group" aria-label="Filter quotes list">
        <button
          type="button"
          className={`sales-dashboard__stat sales-dashboard__stat--total${quoteListFilter === 'all' ? ' sales-dashboard__stat--active' : ''}`}
          aria-pressed={quoteListFilter === 'all'}
          onClick={() => setQuoteListFilter('all')}
        >
          <span className="sales-dashboard__stat-icon">
            <SalesStatIcon name="total" />
          </span>
          <div className="sales-dashboard__stat-text">
            <span className="sales-dashboard__stat-value">{stats.total}</span>
            <span className="sales-dashboard__stat-label">Total quotes</span>
          </div>
        </button>
        <button
          type="button"
          className={`sales-dashboard__stat sales-dashboard__stat--final${quoteListFilter === 'finals' ? ' sales-dashboard__stat--active' : ''}`}
          aria-pressed={quoteListFilter === 'finals'}
          onClick={() => setQuoteListFilter('finals')}
        >
          <span className="sales-dashboard__stat-icon">
            <SalesStatIcon name="final" />
          </span>
          <div className="sales-dashboard__stat-text">
            <span className="sales-dashboard__stat-value">{stats.finals}</span>
            <span className="sales-dashboard__stat-label">Finalized</span>
          </div>
        </button>
        <button
          type="button"
          className={`sales-dashboard__stat sales-dashboard__stat--match${quoteListFilter === 'poMatched' ? ' sales-dashboard__stat--active' : ''}`}
          aria-pressed={quoteListFilter === 'poMatched'}
          onClick={() => setQuoteListFilter('poMatched')}
        >
          <span className="sales-dashboard__stat-icon">
            <SalesStatIcon name="match" />
          </span>
          <div className="sales-dashboard__stat-text">
            <span className="sales-dashboard__stat-value">{stats.poMatched}</span>
            <span className="sales-dashboard__stat-label">PO uploaded</span>
          </div>
        </button>
        <button
          type="button"
          className={`sales-dashboard__stat sales-dashboard__stat--rejected${quoteListFilter === 'rejected' ? ' sales-dashboard__stat--active' : ''}`}
          aria-pressed={quoteListFilter === 'rejected'}
          onClick={() => setQuoteListFilter('rejected')}
        >
          <span className="sales-dashboard__stat-icon">
            <SalesStatIcon name="rejected" />
          </span>
          <div className="sales-dashboard__stat-text">
            <span className="sales-dashboard__stat-value">{stats.rejected}</span>
            <span className="sales-dashboard__stat-label">Rejected</span>
          </div>
        </button>
      </div>

      <div
        className={
          'sales-dashboard__quotes-block' +
          (finalizedCount === 0 ? ' sales-dashboard__quotes-block--empty' : '')
        }
      >
        <div className="sales-dashboard__quotes-head">
          <h3 className="sales-dashboard__section-title" id="sales-quotes-heading">
            Quotes
          </h3>
          {stats.drafts > 0 ? (
            <Link to="/sales/drafts" className="sales-dashboard__drafts-link">
              {stats.drafts} draft{stats.drafts === 1 ? '' : 's'} in sidebar →
            </Link>
          ) : null}
        </div>

      {finalizedCount === 0 ? (
        <div
          className="sales-dashboard__quotes-empty"
          role="region"
          aria-labelledby="sales-quotes-heading"
        >
          <div
            className={
              'sales-dashboard__empty-card' +
              (invoiceDragOver ? ' sales-dashboard__empty-card--drag' : '')
            }
            onDragEnter={(e) => {
              e.preventDefault()
              setInvoiceDragOver(true)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setInvoiceDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setInvoiceDragOver(false)
              }
            }}
            onDrop={onInvoiceDrop}
          >
            {stats.drafts > 0 ? (
              <p className="muted sales-dashboard__empty-draft-hint">
                You have {stats.drafts} draft{stats.drafts === 1 ? '' : 's'} in the
                sidebar. Finalized quotes will appear here.
              </p>
            ) : null}
            <p className="sales-dashboard__empty-drop-hint muted">
              Drop an invoice here or use the button below
            </p>
            <Link
              to="/sales/quote/from-invoice"
              className="btn btn-primary sales-dashboard__empty-cta"
              aria-label="Upload invoice to create a new quote"
            >
              Upload invoice
            </Link>
          </div>
        </div>
      ) : displayedQuotes.length === 0 ? (
        <div className="sales-dashboard__filter-empty">
          <p className="sales-dashboard__filter-empty-text muted">
            No quotes match this filter.
          </p>
          <button
            type="button"
            className="btn btn-primary btn--compact"
            onClick={() => setQuoteListFilter('all')}
          >
            Show all quotes
          </button>
        </div>
      ) : (
        <div className="sales-dashboard__table-wrap">
          <table className="sales-dashboard__table">
            <thead>
              <tr>
                <th scope="col">Quote no.</th>
                <th scope="col">Recipient</th>
                <th scope="col">Quote date</th>
                <th scope="col" className="sales-dashboard__table-col--po-match">
                  PO status
                </th>
                <th scope="col" className="sales-dashboard__table-col--status">
                  Status
                </th>
                <th
                  scope="col"
                  className="sales-dashboard__table-col--menu sales-dashboard__table-col--menu-head"
                  title="Preview, share, and download (where available)"
                  aria-label="Preview, share, and download"
                >
                  ⋯
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedQuotes.map((row) => (
                <SalesQuoteTableRowGroup
                  key={row.id}
                  row={row}
                  onDeleteDraft={handleDeleteDraft}
                  onOpenShare={setShareTarget}
                  onOpenEyePreview={setEyeModal}
                  refreshList={refreshList}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </section>
  )
}
