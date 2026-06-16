import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { extractInvoiceLineItemsFromFile, extractInvoiceRawTextForFooterScan } from '../lib/extractInvoiceLineItems'
import {
  parseInvoiceFooterAmounts,
  resolveInvoiceGrandTotalInr,
  type ParsedInvoiceFooterAmounts,
} from '../lib/invoiceFooterAmounts'
import {
  QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY,
  QUOTE_INVOICE_VENDOR_BRIDGE_KEY,
  type QuoteInvoiceSeedPayload,
  type QuoteInvoiceVendorBridgePayload,
} from '../lib/quoteInvoiceSeed'

const MAX_BOOTSTRAP_INVOICE_BYTES = 2_600_000

const FORMAT_CHIPS = ['PDF', 'Excel', 'CSV', 'Photo'] as const

function readLocalFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('read_failed'))
    }
    reader.onerror = () => reject(new Error('read_failed'))
    reader.readAsDataURL(file)
  })
}

/** Browsers differ on MIME; extraction uses the file name when the type is missing. */
const ACCEPT = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.tsv',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/csv',
  'image/*',
].join(',')

function parseMoney(raw: string | undefined): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

type InvoiceTotalRow = {
  label: string
  amount: number
  kind: 'subtotal' | 'charge' | 'total'
}

function buildInvoiceTotalRows(
  lineSubtotal: number,
  footer: ParsedInvoiceFooterAmounts | null,
  grand: number,
): InvoiceTotalRow[] {
  const rows: InvoiceTotalRow[] = []
  const footerSub = footer?.subtotal
  const subtotal =
    footerSub != null &&
    Number.isFinite(footerSub) &&
    footerSub > 0 &&
    Math.abs(footerSub - lineSubtotal) < 2
      ? footerSub
      : lineSubtotal

  rows.push({ label: 'Subtotal (lines)', amount: subtotal, kind: 'subtotal' })

  const impliedTax = grand - subtotal
  const taxFromFooter =
    footer?.totalTaxAmount != null &&
    Number.isFinite(footer.totalTaxAmount) &&
    footer.totalTaxAmount > 0
      ? footer.totalTaxAmount
      : null

  const taxAmount =
    taxFromFooter != null && Math.abs(subtotal + taxFromFooter - grand) < 1.5
      ? taxFromFooter
      : impliedTax > 0.02
        ? impliedTax
        : null

  if (taxAmount != null && taxAmount > 0.02) {
    rows.push({
      label: 'GST / tax (from invoice)',
      amount: taxAmount,
      kind: 'charge',
    })
  }

  rows.push({ label: 'Grand total (INR)', amount: grand, kind: 'total' })
  return rows
}

function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
      />
    </svg>
  )
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9.75m3 0h3.75M9.75 9h.008v.008H9.75V9zm0 3.75h.008v.008H9.75v-.008zM9.75 12.75h.008v.008H9.75v-.008zm3.75 0h.008v.008H15.75v-.008zM9.75 16.5h.008v.008H9.75V16.5zm3.75 0h.008v.008H15.75V16.5z"
      />
    </svg>
  )
}

type InvoiceImportLocationState = {
  pendingInvoiceFile?: File
}

export function InvoiceToQuotePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const inputRef = useRef<HTMLInputElement>(null)
  const lastImportedFileRef = useRef<File | null>(null)
  const pendingDropHandledRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<QuoteInvoiceSeedPayload | null>(null)
  const [footerTotals, setFooterTotals] = useState<ParsedInvoiceFooterAmounts | null>(null)

  const handleFile = useCallback(
    async (file: File | null) => {
      lastImportedFileRef.current = null
      setMessage(null)
      setPreview(null)
      setFooterTotals(null)
      setOcrProgress(null)
      if (!file) return
      setBusy(true)
      try {
        const res = await extractInvoiceLineItemsFromFile(file, {
          onOcrProgress: (pct) => setOcrProgress(pct),
        })
        if (!res.ok) {
          setMessage(res.message)
          return
        }
        lastImportedFileRef.current = file
        try {
          sessionStorage.removeItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY)
        } catch {
          /* ignore */
        }
        const rawText = await extractInvoiceRawTextForFooterScan(file)
        const footer = parseInvoiceFooterAmounts(rawText)
        setFooterTotals(footer)
        setPreview({
          lines: res.lines,
          sourceFileName: file.name,
        })
      } finally {
        setBusy(false)
        setOcrProgress(null)
      }
    },
    [],
  )

  useEffect(() => {
    const state = location.state as InvoiceImportLocationState | null
    const file = state?.pendingInvoiceFile
    if (!file || pendingDropHandledRef.current) return
    pendingDropHandledRef.current = true
    navigate(location.pathname, { replace: true, state: null })
    void handleFile(file)
  }, [location.pathname, location.state, navigate, handleFile])

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (busy) return
      const file = e.dataTransfer.files?.[0] ?? null
      void handleFile(file)
    },
    [busy, handleFile],
  )

  const handleContinue = useCallback(() => {
    if (!preview) return
    void (async () => {
      const file = lastImportedFileRef.current
      let enriched: QuoteInvoiceSeedPayload = { ...preview }

      try {
        if (
          file &&
          file.name === preview.sourceFileName &&
          file.size <= MAX_BOOTSTRAP_INVOICE_BYTES
        ) {
          const dataUrl = await readLocalFileAsDataUrl(file)
          const comma = dataUrl.indexOf(',')
          const base64 = comma !== -1 ? dataUrl.slice(comma + 1) : ''
          const mimeRaw = file.type?.trim()
          enriched = {
            ...preview,
            sourceBase64: base64 || undefined,
            sourceMimeType:
              mimeRaw ||
              (file.name.toLowerCase().endsWith('.pdf')
                ? 'application/pdf'
                : 'application/octet-stream'),
          }
          try {
            const bridge: QuoteInvoiceVendorBridgePayload = {
              fileName: file.name,
              mimeType: enriched.sourceMimeType || 'application/octet-stream',
              dataBase64: base64,
            }
            sessionStorage.setItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY, JSON.stringify(bridge))
          } catch {
            /* ignore bridge */
          }
        } else if (file && file.size > MAX_BOOTSTRAP_INVOICE_BYTES) {
          setMessage(
            'Invoice file exceeds the attachment size limit (~2.5 MB). You can continue; Finance may ask for the file separately.',
          )
        }
      } catch {
        setMessage(
          'Could not read the invoice file for attachment. Lines will still carry over; Finance may ask for the invoice file separately.',
        )
      }

      try {
        sessionStorage.setItem(
          QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY,
          JSON.stringify(enriched),
        )
      } catch {
        setMessage('Could not store import data. Check browser storage settings.')
        return
      }
      navigate('/sales/quote/new?bootstrap=1')
    })()
  }, [navigate, preview])

  const lineSubtotal = preview
    ? preview.lines.reduce((sum, row) => {
        const qty = parseMoney(row.qty)
        const rate = parseMoney(row.vendorUnitPrice)
        if (qty <= 0 || rate <= 0) return sum
        return sum + qty * rate
      }, 0)
    : 0

  const grand = footerTotals
    ? resolveInvoiceGrandTotalInr(footerTotals, lineSubtotal)
    : lineSubtotal

  const totalRows = preview
    ? buildInvoiceTotalRows(lineSubtotal, footerTotals, grand)
    : []

  return (
    <div className="invoice-import">
      <header className="invoice-import__hero">
        <div className="invoice-import__hero-top">
          <Link to="/sales" className="invoice-import__back">
            ← Back to Sales
          </Link>
        </div>
        <h1 className="invoice-import__title">New quote from invoice</h1>
      </header>

      {message ? (
        <div className="invoice-import__alert form-validation-banner" role="alert">
          {message}
        </div>
      ) : null}

      {!preview ? (
        <section className="invoice-import__upload-section" aria-label="Upload invoice">
          <button
            type="button"
            className={`invoice-import__dropzone${dragOver ? ' invoice-import__dropzone--active' : ''}${busy ? ' invoice-import__dropzone--busy' : ''}`}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
            onDrop={onDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="invoice-import__file-input"
              disabled={busy}
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const file = e.currentTarget.files?.[0] ?? null
                e.currentTarget.value = ''
                void handleFile(file)
              }}
            />
            <span className="invoice-import__dropzone-icon" aria-hidden>
              <IconUpload />
            </span>
            {busy ? (
              <div className="invoice-import__progress">
                <p className="invoice-import__dropzone-title" aria-busy="true">
                  {ocrProgress !== null ? 'Recognizing text…' : 'Reading file…'}
                </p>
                {ocrProgress !== null ? (
                  <div className="invoice-import__progress-track" role="progressbar" aria-valuenow={ocrProgress} aria-valuemin={0} aria-valuemax={100}>
                    <span
                      className="invoice-import__progress-fill"
                      style={{ width: `${ocrProgress}%` }}
                    />
                  </div>
                ) : (
                  <div className="invoice-import__progress-track invoice-import__progress-track--indeterminate">
                    <span className="invoice-import__progress-fill" />
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className="invoice-import__dropzone-title">Drop your invoice here</p>
                <p className="invoice-import__dropzone-sub">or click to browse files</p>
              </>
            )}
          </button>
          <ul className="invoice-import__formats" aria-label="Supported formats">
            {FORMAT_CHIPS.map((label) => (
              <li key={label} className="invoice-import__format-chip">
                {label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {preview ? (
        <section className="invoice-import__results" aria-label="Extracted invoice data">
          <div className="invoice-import__results-head">
            <div className="invoice-import__file-badge">
              <span className="invoice-import__file-icon" aria-hidden>
                <IconFile />
              </span>
              <div>
                <h2 className="invoice-import__results-title">{preview.sourceFileName}</h2>
                <p className="invoice-import__results-meta">
                  {preview.lines.length} line{preview.lines.length === 1 ? '' : 's'} extracted
                </p>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost invoice-import__change-file"
              onClick={() => {
                setPreview(null)
                setFooterTotals(null)
                setMessage(null)
                if (inputRef.current) inputRef.current.value = ''
              }}
            >
              Change file
            </button>
          </div>

          <div className="invoice-import__table-wrap">
            <table className="invoice-import__table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Product</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="invoice-import__cell--num">
                    Qty
                  </th>
                  <th scope="col" className="invoice-import__cell--num">
                    Supplier rate
                  </th>
                  <th scope="col" className="invoice-import__cell--num">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((row, i) => {
                  const qty = parseMoney(row.qty)
                  const rate = parseMoney(row.vendorUnitPrice)
                  const total = qty > 0 && rate > 0 ? qty * rate : 0
                  return (
                    <tr key={`${i}-${row.description.slice(0, 20)}`}>
                      <td className="invoice-import__cell--idx">{i + 1}</td>
                      <td>{row.product || '—'}</td>
                      <td className="invoice-import__cell--desc">{row.description || '—'}</td>
                      <td className="invoice-import__cell--num">{row.qty}</td>
                      <td className="invoice-import__cell--num">
                        {row.vendorUnitPrice ?? '—'}
                      </td>
                      <td className="invoice-import__cell--num">
                        {total > 0 ? formatInr(total) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="invoice-import__totals" aria-label="Invoice total breakdown">
            <table className="invoice-import__totals-table">
              <tbody>
                {totalRows.map((row) => (
                  <tr
                    key={row.label}
                    className={
                      row.kind === 'total'
                        ? 'invoice-import__totals-row--grand'
                        : row.kind === 'charge'
                          ? 'invoice-import__totals-row--charge'
                          : undefined
                    }
                  >
                    <th scope="row">{row.label}</th>
                    <td>
                      {row.kind === 'charge'
                        ? `${row.amount >= 0 ? '+' : '−'}₹${formatInr(Math.abs(row.amount))}`
                        : `₹${formatInr(row.amount)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="invoice-import__actions">
            <button type="button" className="btn btn-primary invoice-import__continue" onClick={handleContinue}>
              Continue to quote →
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
