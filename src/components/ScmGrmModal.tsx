import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSavedQuoteById, updateSavedQuoteScmGrm } from '../lib/savedQuotesStorage'
import {
  getScmGrmProgress,
  isLineGrmFullyReceived,
  isLineGrmHasReceipt,
  isLineGrmOpenForReceipt,
  mergeScmGrmWithLines,
  parseGrmOrderQty,
  parseGrmReceivedFromString,
  parseGrmSessionDeltaString,
  normalizeGrmSessionKeypadString,
  clampGrmSessionInputDisplay,
  formatGrmQty,
  scmGrmRelevantLines,
} from '../lib/scmGrmUtils'
import type { ScmGrmState } from '../types/scmGrm'
import type { ScmPoLine } from '../types/scmPo'
import { downloadScmPoPdfFromRenderedPreview } from '../lib/scmPoPdf'
import { ScmGrmReceiptDocumentPreview } from './ScmGrmReceiptDocumentPreview'

type LineFilter = 'open' | 'all' | 'delivered'

type Props = {
  quoteId: string
  onClose: () => void
  onSaved: () => void
}

function lineLabel(line: ScmPoLine): string {
  const p = (line.partNumber || '').trim()
  const d = (line.itemDetails || '').trim()
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const head = p || d || 'Line'
  const rest =
    p && d && norm(p) !== norm(d)
      ? `${d.slice(0, 80)}${d.length > 80 ? '…' : ''}`
      : ''
  const combined = rest ? `${head} — ${rest}` : head
  return combined.length > 100 ? `${combined.slice(0, 98)}…` : combined
}

function grmStateFromQuantityMap(quantityById: Record<string, string>): ScmGrmState {
  return {
    lineStatusById: {},
    quantityReceivedById: quantityById,
    updatedAt: '',
  } as ScmGrmState
}

export function ScmGrmModal({ quoteId, onClose, onSaved }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Cumulative from saved GRN at modal open (line id → str). */
  const [baselineReceivedById, setBaselineReceivedById] = useState<Record<string, string>>({})
  /** Amount to record in this GRN only (starts at 0; added to baseline on save). */
  const [sessionReceivedById, setSessionReceivedById] = useState<Record<string, string>>({})
  const [filterQtyBaseline, setFilterQtyBaseline] = useState<Record<string, string> | null>(null)
  const [lineFilter, setLineFilter] = useState<LineFilter>('open')
  /** Cumulative saved totals — PDF from toolbar (manual download). */
  const savedReceiptRef = useRef<HTMLDivElement | null>(null)
  const [downloadSavedBusy, setDownloadSavedBusy] = useState(false)

  const rec = useMemo(() => getSavedQuoteById(quoteId), [quoteId])
  const scmPo = rec?.scmPo
  const lines = scmPo?.lines ?? []
  const rel = useMemo(() => scmGrmRelevantLines(lines), [lines])

  const effectiveQuantityById = useMemo(() => {
    const o: Record<string, string> = {}
    for (const line of rel) {
      const order = parseGrmOrderQty(line)
      const b = parseGrmReceivedFromString(baselineReceivedById[line.id] ?? '0', order)
      const s = parseGrmSessionDeltaString(
        sessionReceivedById[line.id] ?? '',
        order,
        b,
      )
      o[line.id] = formatGrmQty(Math.min(order, b + s))
    }
    return o
  }, [rel, baselineReceivedById, sessionReceivedById])

  const merged = useMemo(
    () => mergeScmGrmWithLines(rel, grmStateFromQuantityMap(effectiveQuantityById)),
    [rel, effectiveQuantityById],
  )

  const mergedFilter = useMemo(() => {
    if (!filterQtyBaseline) return null
    return mergeScmGrmWithLines(rel, grmStateFromQuantityMap(filterQtyBaseline))
  }, [rel, filterQtyBaseline])

  useEffect(() => {
    setLineFilter('open')
  }, [quoteId])

  useEffect(() => {
    const r = getSavedQuoteById(quoteId)
    if (!r?.scmPo) return
    const m = mergeScmGrmWithLines(scmGrmRelevantLines(r.scmPo.lines), r.scmGrm)
    setBaselineReceivedById({ ...m.quantityReceivedById })
    setFilterQtyBaseline({ ...m.quantityReceivedById })
    const z: Record<string, string> = {}
    for (const l of scmGrmRelevantLines(r.scmPo.lines)) z[l.id] = ''
    setSessionReceivedById(z)
  }, [quoteId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const progress = useMemo(() => {
    if (!scmPo) {
      return { total: 0, pending: 0, partial: 0, delivered: 0, isComplete: false }
    }
    return getScmGrmProgress(scmPo.lines, {
      lineStatusById: merged.lineStatusById,
      quantityReceivedById: merged.quantityReceivedById,
      updatedAt: '',
    } as ScmGrmState)
  }, [scmPo, merged])

  const applySessionString = useCallback((line: ScmPoLine, raw: string) => {
    const order = parseGrmOrderQty(line)
    const b = parseGrmReceivedFromString(baselineReceivedById[line.id] ?? '0', order)
    const display = clampGrmSessionInputDisplay(
      normalizeGrmSessionKeypadString(raw),
      order,
      b,
    )
    setSessionReceivedById((q) => ({
      ...q,
      [line.id]: display,
    }))
  }, [baselineReceivedById])

  const setSessionFullRemaining = useCallback(
    (line: ScmPoLine) => {
      const order = parseGrmOrderQty(line)
      const b = parseGrmReceivedFromString(baselineReceivedById[line.id] ?? '0', order)
      const maxS = Math.max(0, order - b)
      setSessionReceivedById((q) => ({
        ...q,
        [line.id]: maxS === 0 ? '' : formatGrmQty(maxS),
      }))
    },
    [baselineReceivedById],
  )

  const linesToShow = useMemo(() => {
    if (lineFilter === 'all') return rel
    if (lineFilter === 'open' && mergedFilter) {
      return rel.filter((l) => isLineGrmOpenForReceipt(l, mergedFilter))
    }
    return rel.filter((l) => isLineGrmHasReceipt(l, merged))
  }, [rel, lineFilter, mergedFilter, merged])

  const handleSave = useCallback(async () => {
    const r = getSavedQuoteById(quoteId)
    if (!r?.scmPo) return
    setSaving(true)
    setError(null)
    try {
      const relLines = scmGrmRelevantLines(r.scmPo.lines)
      const effective: Record<string, string> = {}
      for (const line of relLines) {
        const order = parseGrmOrderQty(line)
        const b = parseGrmReceivedFromString(baselineReceivedById[line.id] ?? '0', order)
        const s = parseGrmSessionDeltaString(
          sessionReceivedById[line.id] ?? '',
          order,
          b,
        )
        effective[line.id] = formatGrmQty(Math.min(order, b + s))
      }
      const m = mergeScmGrmWithLines(relLines, {
        ...grmStateFromQuantityMap(effective),
      } as ScmGrmState)
      const res = updateSavedQuoteScmGrm(quoteId, {
        lineStatusById: m.lineStatusById,
        quantityReceivedById: m.quantityReceivedById,
        updatedAt: new Date().toISOString(),
      })
      if (!res) {
        setError('Could not save GRN. Try again.')
        return
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }, [quoteId, baselineReceivedById, sessionReceivedById, onClose, onSaved])

  if (!rec?.scmPo) {
    return (
      <div
        className="modal-backdrop"
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-card" role="alert" aria-modal="true">
          <p className="modal-card__desc" style={{ margin: 0 }}>
            No purchase order for this record.
          </p>
        </div>
      </div>
    )
  }

  const po = rec.scmPo

  /** Cumulative qty already saved — toolbar PDF. */
  const savedReceiptRowsForPdf = useMemo(() => {
    const out: Array<{ line: ScmPoLine; receivedQty: string }> = []
    for (const line of rel) {
      const order = parseGrmOrderQty(line)
      const b = parseGrmReceivedFromString(baselineReceivedById[line.id] ?? '0', order)
      if (b > 0) out.push({ line, receivedQty: formatGrmQty(b) })
    }
    return out
  }, [rel, baselineReceivedById])

  const savedReceiptTimestampIso = useMemo(() => {
    const t = (rec.scmGrm?.updatedAt || '').trim()
    return t || new Date().toISOString()
  }, [rec.scmGrm?.updatedAt])

  const handleDownloadSavedReceipt = useCallback(async () => {
    if (downloadSavedBusy || savedReceiptRowsForPdf.length === 0) return
    const el = savedReceiptRef.current
    if (!el) return
    setDownloadSavedBusy(true)
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      await downloadScmPoPdfFromRenderedPreview({
        previewRoot: el,
        filenameBase: `GRN-${(po.poRef || '').trim() || 'PO'}-record`,
      })
    } finally {
      setDownloadSavedBusy(false)
    }
  }, [downloadSavedBusy, savedReceiptRowsForPdf.length, po.poRef])

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal-card scm-grm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scm-grm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="scm-grm-title" className="modal-card__title">
          GRN — {(rec.ovf?.ovfRef || '').trim() || 'OVF'}
        </h3>
        {savedReceiptRowsForPdf.length > 0 ? (
          <div className="scm-grm-modal__toolbar">
            <button
              type="button"
              className="btn btn-ghost btn--compact"
              onClick={() => void handleDownloadSavedReceipt()}
              disabled={downloadSavedBusy || saving}
              title="Download receipt PDF (totals on record)"
              aria-label="Download receipt PDF (totals on record)"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
            </button>
          </div>
        ) : null}

        <div className="scm-grm-modal__receipt-export" aria-hidden="true">
          <div ref={savedReceiptRef}>
            <ScmGrmReceiptDocumentPreview
              grmRef={quoteId}
              poRef={(po.poRef || '').trim() || 'PO'}
              createdAtIso={savedReceiptTimestampIso}
              rows={savedReceiptRowsForPdf}
            />
          </div>
        </div>

        {rel.length === 0 ? (
          <p className="muted" style={{ margin: '0.5rem 0' }}>
            There are no line items on this PO. Add lines on the PO editor, then return here.
          </p>
        ) : (
          <>
            {progress.isComplete ? (
              <p className="scm-grm-modal__banner" role="status">
                All order quantities are fully received — <strong>GRN complete (PO closed for receipt)</strong>.
              </p>
            ) : null}
            <label className="scm-grm-modal__view-filter">
              <span className="scm-po__label" style={{ margin: 0 }}>
                View
              </span>
              <select
                className="field__control"
                value={lineFilter}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'open' || v === 'all' || v === 'delivered') {
                    setLineFilter(v)
                  }
                }}
              >
                <option value="open">Open lines</option>
                <option value="all">All lines</option>
                <option value="delivered">This GRN entries</option>
              </select>
            </label>
            {linesToShow.length === 0 && lineFilter === 'open' ? (
              <p className="scm-grm-modal__empty-hint muted">
                No open lines. Use <strong>All lines</strong> or <strong>This GRN entries</strong>.
              </p>
            ) : (
              <ul className="scm-grm-modal__line-list" aria-label="PO line quantities received">
                {linesToShow.map((line) => {
                  const order = parseGrmOrderQty(line)
                  const onRecord = parseGrmReceivedFromString(
                    baselineReceivedById[line.id] ?? '0',
                    order,
                  )
                  const thisReceipt = parseGrmSessionDeltaString(
                    sessionReceivedById[line.id] ?? '',
                    order,
                    onRecord,
                  )
                  const totalAfterSave = Math.min(order, onRecord + thisReceipt)
                  const valueStr = sessionReceivedById[line.id] ?? ''
                  const left = Math.max(0, order - totalAfterSave)
                  const lineDone = isLineGrmFullyReceived(line, merged)
                  const maxThisReceipt = Math.max(0, order - onRecord)
                  const ord = formatGrmQty(order)
                  const pTrim = (line.partNumber || '').trim()
                  const detailFirst =
                    (line.itemDetails || '')
                      .split(/\n/)
                      .map((x) => x.trim())
                      .find((x) => x.length > 0) ?? ''
                  const norm = (s: string) =>
                    s.replace(/\s+/g, ' ').trim().toLowerCase()
                  const showPartMeta =
                    Boolean(pTrim) && norm(pTrim) !== norm(detailFirst)
                  const metaParts = [
                    showPartMeta ? pTrim : '',
                    lineDone ? `${ord} ordered, complete` : `${ord} total`,
                  ].filter((x): x is string => Boolean(x))
                  return (
                    <li key={line.id} className="scm-grm-modal__line scm-grm-modal__line--qty">
                      <div className="scm-grm-modal__line-text">
                        <div className="scm-grm-modal__line-title">{lineLabel(line)}</div>
                        {metaParts.length > 0 ? (
                          <div className="scm-grm-modal__line-meta">{metaParts.join(' · ')}</div>
                        ) : null}
                      </div>
                      <div className="scm-grm-modal__qty-controls">
                        <div className="scm-grm-modal__qty-pair">
                          <span className="scm-grm-modal__qty-label">Left</span>
                          <span
                            className="scm-grm-modal__qty-readonly"
                            title={
                              onRecord > 0
                                ? `${formatGrmQty(left)} to receive. PO: ${formatGrmQty(order)}. On record: ${formatGrmQty(onRecord)}. This GRN: up to ${formatGrmQty(maxThisReceipt)}.`
                                : `${formatGrmQty(left)} to receive. PO line: ${formatGrmQty(order)}.`
                            }
                            aria-label="Quantity left to receive for this line"
                          >
                            {lineDone ? '0' : formatGrmQty(left)}
                          </span>
                        </div>
                        <div className="scm-grm-modal__qty-pair">
                          <label className="scm-grm-modal__qty-label" htmlFor={`scm-grm-recv-${line.id}`}>
                            This receipt
                          </label>
                          <input
                            id={`scm-grm-recv-${line.id}`}
                            className="field__control scm-grm-modal__qty-input"
                            type="text"
                            inputMode="decimal"
                            value={valueStr}
                            placeholder="0"
                            onChange={(e) => {
                              const display = clampGrmSessionInputDisplay(
                                normalizeGrmSessionKeypadString(e.target.value),
                                order,
                                onRecord,
                              )
                              setSessionReceivedById((q) => ({
                                ...q,
                                [line.id]: display,
                              }))
                            }}
                            onFocus={(e) => {
                              if (e.currentTarget.value === '0') e.currentTarget.select()
                            }}
                            onBlur={(e) => applySessionString(line, e.currentTarget.value)}
                            aria-label={`Units for this GRN, 0 to ${formatGrmQty(maxThisReceipt)}. ${lineLabel(line)}.`}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn--compact scm-grm-modal__full-btn"
                          onClick={() => setSessionFullRemaining(line)}
                        >
                          Full
                        </button>
                      </div>
                      {isLineGrmFullyReceived(line, merged) ? (
                        <span className="scm-grm-modal__line-done" title="Line fully received" aria-hidden>
                          ✓
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {error ? <p className="modal-card__error">{error}</p> : null}

        <div className="modal-card__actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || rel.length === 0}
          >
            {saving ? 'Saving…' : 'Save GRN'}
          </button>
        </div>
      </div>
    </div>
  )
}
