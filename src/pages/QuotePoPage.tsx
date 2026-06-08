import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, Navigate, useParams } from 'react-router-dom'
import { QuoteDetailsPreviewPanel } from '../components/QuoteDetailsPreviewPanel'
import { useAuth } from '../context/useAuth'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { poMatchLabel, quoteGrandTotalInr } from '../lib/quotePoMatch'
import { effectivePoFinanceStatus, usesInvoiceQuotePipeline } from '../lib/quotePipeline'
import {
  getSavedQuoteByIdForUser,
  isQuoteDraft,
  mergePoFinanceReviewOnRecord,
  submitMatchedPoToFinanceForRecord,
  upsertPoFinanceReviewOnRecord,
  updateSavedQuotePo,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import { extractPoNumberFromAttachment } from '../lib/extractPoNumber'
import { extractPoTotalFromAttachment } from '../lib/extractPoTotal'
import { formatQuoteDateDisplay } from '../lib/senderAddresses'
import type { QuoteFormData } from '../types/quotePdf'
import type { QuotePoState } from '../types/quotePo'

const MAX_PO_BYTES = 1_800_000

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Pretty-print stored PO total string for Result copy. */
function formatPoTotalDisplay(raw: string | undefined): string {
  const t = String(raw ?? '').trim()
  if (!t) return '—'
  const n = Number.parseFloat(t.replace(/,/g, ''))
  if (Number.isFinite(n)) return formatInr(n)
  return t
}

export type QuotePoPanelProps = {
  quoteId: string
  variant: 'page' | 'modal'
  onClose?: () => void
  onPersisted?: () => void
}

export function QuotePoPanel({
  quoteId,
  variant,
  onClose,
  onPersisted,
}: QuotePoPanelProps) {
  const { user } = useAuth()
  const [record, setRecord] = useState<SavedQuoteRecord | null | undefined>(
    undefined,
  )
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)

  const reload = useCallback(() => {
    if (!user || !quoteId) {
      setRecord(null)
      return
    }
    const r = getSavedQuoteByIdForUser(quoteId, user.oid)
    setRecord(r ?? null)
  }, [user, quoteId])

  useEffect(() => {
    reload()
  }, [reload])

  const data = useMemo(() => {
    if (!record) return null
    return normalizeQuoteFormData(
      record.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
  }, [record])

  const quoteTotal = data ? quoteGrandTotalInr(data) : 0
  const match = record && data ? poMatchLabel(data, record.po) : 'none'
  const invoicePath = Boolean(record && usesInvoiceQuotePipeline(record))
  const poFinance = record ? effectivePoFinanceStatus(record) : 'none'

  async function handlePoFile(file: File | null) {
    setSaveMsg(null)
    if (!file || !user || !record || !quoteId) return
    if (file.size > MAX_PO_BYTES) {
      setSaveMsg(
        `File is too large (max ~${Math.round(MAX_PO_BYTES / 1024)} KB). Use a smaller PDF or image.`,
      )
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') return
      void (async () => {
        const numRes = await extractPoNumberFromAttachment(
          result,
          file.name,
          file.type || 'application/octet-stream',
        )
        const extracted = numRes.ok ? numRes.poNumber.trim() : ''
        const po: QuotePoState = {
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          dataBase64: result,
          uploadedAt: new Date().toISOString(),
          poTotalInr: record.po?.poTotalInr || '',
          customerPoNumber: extracted || undefined,
          comparedAt: record.po?.comparedAt,
          quoteTotalInrAtCompare: record.po?.quoteTotalInrAtCompare,
          quoteChangedAfterCompareAt: record.po?.quoteChangedAfterCompareAt,
        }
        const updated = updateSavedQuotePo(quoteId, user.oid, po)
        if (updated) {
          setRecord(updated)
          let msg = 'PO file saved.'
          if (extracted) {
            msg = `PO file saved. Customer PO #: ${extracted}.`
          } else if (!numRes.ok) {
            msg = `PO file saved. ${numRes.message}`
          }
          setSaveMsg(msg)
          onPersisted?.()
        }
      })()
    }
    reader.readAsDataURL(file)
  }

  function handleClearPo() {
    if (!user || !quoteId) return
    if (!window.confirm('Remove PO file and totals from this quote?')) return
    const updated = updateSavedQuotePo(quoteId, user.oid, undefined)
    if (updated) {
      setRecord(updated)
      setSaveMsg('PO cleared.')
      onPersisted?.()
    }
  }

  const hasPoAttachment = Boolean(
    record?.po?.dataBase64 &&
      record.po.fileName &&
      record.po.fileName !== '(no file yet)',
  )

  const handleCompareTotals = useCallback(async () => {
    setSaveMsg(null)
    if (!user || !record?.po || !quoteId || !data || !hasPoAttachment) return
    setComparing(true)
    try {
      const res = await extractPoTotalFromAttachment(
        record.po.dataBase64,
        record.po.fileName,
        record.po.mimeType,
        quoteTotal,
      )
      if (!res.ok) {
        setSaveMsg(res.message)
        return
      }
      const po: QuotePoState = {
        ...record.po,
        poTotalInr: res.amountStr,
        comparedAt: new Date().toISOString(),
        quoteTotalInrAtCompare: quoteTotal,
        quoteChangedAfterCompareAt: undefined,
      }
      const updated = updateSavedQuotePo(quoteId, user.oid, po)
      if (updated) {
        setRecord(updated)
        setSaveMsg(
          `Detected PO total ${res.amountStr} INR — compared to quote total above.`,
        )
        onPersisted?.()
      }
    } finally {
      setComparing(false)
    }
  }, [
    user,
    record,
    quoteId,
    data,
    hasPoAttachment,
    quoteTotal,
    onPersisted,
  ])

  if (!user) {
    if (variant === 'page') {
      return <Navigate to="/sales" replace />
    }
    return (
      <div className="quote-po-page__modal-fallback">
        <p className="muted">You need to be signed in.</p>
        {onClose ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    )
  }

  if (record === undefined) {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  if (!record || isQuoteDraft(record)) {
    if (variant === 'page') {
      return <Navigate to="/sales" replace />
    }
    return (
      <div className="quote-po-page__modal-fallback">
        <p className="muted">This quote is not available.</p>
        {onClose ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    )
  }

  const sectionClass =
    variant === 'modal'
      ? 'quote-po-page quote-po-page--modal-inner'
      : 'panel quote-po-page'

  return (
    <section className={sectionClass}>
      {variant === 'page' ? (
        <p className="panel__back">
          <Link to="/sales" className="link-back">
            ← Back to quotes
          </Link>
        </p>
      ) : null}
      <h2>Quote {record.quoteRef}</h2>

      <div className="quote-po-page__summary">
        <div>
          <span className="quote-po-page__label">Quote grand total (INR)</span>
          <strong className="quote-po-page__amount">{formatInr(quoteTotal)}</strong>
        </div>
        <div>
          <span className="quote-po-page__label">Recipient</span>
          <span>{data?.customerName.trim() || '—'}</span>
        </div>
        <div>
          <span className="quote-po-page__label">Quote date</span>
          <span>{data ? formatQuoteDateDisplay(data.quoteDate) : '—'}</span>
        </div>
      </div>

      {match === 'matched' && hasPoAttachment && record.po?.dataBase64 ? (
        <p className="muted quote-po-page__attached-readonly">
          PO on file: <strong>{record.po.fileName}</strong> (
          {new Date(record.po.uploadedAt).toLocaleString()}){' '}
          <a
            href={record.po.dataBase64}
            download={record.po.fileName}
            className="quote-po-page__download"
          >
            Download
          </a>
        </p>
      ) : null}

      {match !== 'matched' ? (
        <div className="quote-po-page__upload">
          <label className="field">
            <span className="field__label">Upload PO (PDF or Excel)</span>
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.csv,image/*"
              className="field__control"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0] ?? null
                // Allow selecting the same PO file again to re-run extraction/compare.
                e.currentTarget.value = ''
                void handlePoFile(file)
              }}
            />
          </label>
          {record.po?.fileName ? (
            <p className="muted">
              Current file: <strong>{record.po.fileName}</strong> (
              {new Date(record.po.uploadedAt).toLocaleString()})
              {record.po.dataBase64 ? (
                <>
                  {' '}
                  <a
                    href={record.po.dataBase64}
                    download={record.po.fileName}
                    className="quote-po-page__download"
                  >
                    Download
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {record.po ? (
            <button
              type="button"
              className="btn btn-ghost quote-po-page__clear"
              onClick={() => handleClearPo()}
            >
              Clear PO
            </button>
          ) : null}
        </div>
      ) : null}

      {match !== 'matched' ? (
        <div className="quote-po-page__compare-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasPoAttachment || comparing}
            onClick={() => void handleCompareTotals()}
          >
            {comparing ? 'Reading PO…' : 'Compare totals'}
          </button>
        </div>
      ) : null}

      <h3 className="quote-po-page__comparison-title">Result</h3>
      <div
        className={
          match === 'matched'
            ? 'quote-po-page__match quote-po-page__match--ok'
            : match === 'mismatch'
              ? 'quote-po-page__match quote-po-page__match--bad'
              : 'quote-po-page__match'
        }
      >
        {match === 'none' && <span className="muted">—</span>}
        {match === 'matched' && (
          <div className="quote-po-page__match-copy">
            <p className="quote-po-page__match-lead">
              <strong>Match</strong> — PO total matches quote grand total.
            </p>
            <div className="quote-po-page__match-detail">
              {record.po?.customerPoNumber?.trim() ? (
                <p>
                  <strong>Customer PO number:</strong>{' '}
                  {record.po.customerPoNumber.trim()}
                </p>
              ) : null}
              <p>
                <strong>PO total:</strong>{' '}
                {formatPoTotalDisplay(record.po?.poTotalInr)} INR
              </p>
              <p>
                <strong>Quote grand total:</strong> {formatInr(quoteTotal)} INR
              </p>
            </div>
          </div>
        )}
        {match === 'mismatch' && (
          <div className="quote-po-page__match-copy">
            <p className="quote-po-page__match-lead">
              <strong>No match</strong> — PO total and quote grand total differ.
            </p>
            <div className="quote-po-page__match-detail">
              <p>
                <strong>PO total:</strong>{' '}
                {formatPoTotalDisplay(record.po?.poTotalInr)} INR
              </p>
              <p>
                <strong>Quote grand total:</strong> {formatInr(quoteTotal)} INR
              </p>
            </div>
          </div>
        )}
      </div>

      {saveMsg ? (
        <p className="quote-po-page__msg" role="status">
          {saveMsg}
        </p>
      ) : null}

      {match === 'matched' ? (
        <div className="quote-po-page__ovf">
          <h3 className="quote-po-page__ovf-title">Next steps</h3>
          {invoicePath ? (
            <>
              {poFinance === 'pending_finance' ? (
                <p className="muted" role="status">
                  Customer PO submitted to Finance for GST verification. You will unlock the OVF
                  once Finance approves.
                </p>
              ) : null}
              {poFinance === 'finance_rejected' ? (
                <div className="form-validation-banner" role="alert">
                  {record.poFinanceReview?.financeRejectionNote?.trim() ||
                    'Finance rejected the customer PO. Correct the PO or quote and submit again.'}
                </div>
              ) : null}
              {(poFinance === 'none' || poFinance === 'finance_rejected') &&
              user &&
              quoteId &&
              record ? (
                <p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setSaveMsg(null)
                      const updated = submitMatchedPoToFinanceForRecord(quoteId)
                      if (updated) {
                        setRecord(updated)
                        setSaveMsg(
                          'Customer PO sent to Finance. They will check GST and line detail.',
                        )
                        onPersisted?.()
                      } else {
                        // Fallback: some older rows may not have initialized `poFinanceReview`.
                        // Force-create the pending state so it reaches Finance.
                        const now = new Date().toISOString()
                        const forced =
                          mergePoFinanceReviewOnRecord(quoteId, {
                            workflowStatus: 'pending_finance',
                            submittedToFinanceAt: now,
                            financeRejectionNote: undefined,
                          }) ??
                          upsertPoFinanceReviewOnRecord(quoteId, {
                          workflowStatus: 'pending_finance',
                          submittedToFinanceAt: now,
                          financeRejectionNote: undefined,
                        })
                        if (forced) {
                          setRecord(forced)
                          setSaveMsg(
                            'Customer PO sent to Finance. They will check GST and line detail.',
                          )
                          onPersisted?.()
                        } else {
                          setSaveMsg(
                            'Could not submit to Finance — re-upload the PO file once, then try again.',
                          )
                        }
                      }
                    }}
                  >
                    Submit customer PO to Finance
                  </button>
                </p>
              ) : null}
              {poFinance === 'finance_approved' ? (
                <p>
                  <Link to={`/sales/q/${quoteId}/ovf`} className="btn btn-primary">
                    Open OVF (prefilled from quote + PO)
                  </Link>
                </p>
              ) : null}
              {!(poFinance === 'finance_approved') ? (
                <p className="muted">
                  The OVF screen stays unavailable until Finance approves this customer PO.
                </p>
              ) : null}
            </>
          ) : (
            <Link to={`/sales/q/${quoteId}/ovf`} className="btn btn-primary">
              Open OVF page
            </Link>
          )}
        </div>
      ) : null}
    </section>
  )
}

export function QuotePoPage() {
  const { quoteId } = useParams<{ quoteId: string }>()
  const { user } = useAuth()
  if (!user || !quoteId) {
    return <Navigate to="/sales" replace />
  }
  return <QuotePoPanel quoteId={quoteId} variant="page" />
}

type QuoteDetailsPreviewModalProps = {
  quoteId: string
  onClose: () => void
}

/** Eye icon on Sales overview: read-only quote snapshot (not PO upload/compare). */
export function QuoteDetailsPreviewModal({
  quoteId,
  onClose,
}: QuoteDetailsPreviewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="quote-preview-modal__backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="quote-preview-modal quote-preview-modal--details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quote-details-preview-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="quote-preview-modal__header">
          <h2 id="quote-details-preview-title" className="quote-preview-modal__title">
            Quote details
          </h2>
          <button
            type="button"
            className="share-quote-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="quote-preview-modal__body">
          <QuoteDetailsPreviewPanel quoteId={quoteId} onClose={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
