import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { extractInvoiceLineItemsFromFile } from '../lib/extractInvoiceLineItems'
import {
  QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY,
  QUOTE_INVOICE_VENDOR_BRIDGE_KEY,
  type QuoteInvoiceSeedPayload,
  type QuoteInvoiceVendorBridgePayload,
} from '../lib/quoteInvoiceSeed'

const MAX_BOOTSTRAP_INVOICE_BYTES = 2_600_000

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

export function InvoiceToQuotePage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const lastImportedFileRef = useRef<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<QuoteInvoiceSeedPayload | null>(null)

  const handleFile = useCallback(
    async (file: File | null) => {
      lastImportedFileRef.current = null
      setMessage(null)
      setPreview(null)
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

  return (
    <div className="invoice-to-quote-page">
      <p className="panel__back">
        <Link to="/sales" className="link-back">
          ← Back to Sales
        </Link>
      </p>
      <h2 className="invoice-to-quote-page__title">New quote from invoice</h2>

      <div className="invoice-to-quote-page__card card-surface">
        <label className="field invoice-to-quote-page__upload">
          <span className="field__label">
            Invoice file (Excel, PDF, CSV, photo…)
          </span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="field__control"
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0] ?? null
              // Allow selecting the same file again to re-run analysis.
              e.currentTarget.value = ''
              void handleFile(file)
            }}
          />
        </label>
        {busy ? (
          <p className="muted" aria-busy="true">
            {ocrProgress !== null
              ? `Recognizing text… ${ocrProgress}%`
              : 'Reading file…'}
          </p>
        ) : null}
        {message ? (
          <div className="form-validation-banner" role="alert">
            {message}
          </div>
        ) : null}

        {preview ? (
          <div className="invoice-to-quote-page__preview">
            <h3 className="invoice-to-quote-page__preview-title">
              Extracted from {preview.sourceFileName}
            </h3>
            <p className="muted invoice-to-quote-page__preview-hint">
              {preview.lines.length} line{preview.lines.length === 1 ? '' : 's'} — product,
              description, and qty carry to the quote. A parsed supplier rate (when present) is
              stored for Finance only; you enter the customer unit price on the quote.
            </p>
            <div className="invoice-to-quote-page__table-wrap">
              <table className="invoice-to-quote-page__table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Product (short)</th>
                    <th scope="col">Description</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Supplier rate (parsed)</th>
                    <th scope="col">Total (INR)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((row, i) => {
                    const qty = parseMoney(row.qty)
                    const rate = parseMoney(row.vendorUnitPrice)
                    const total = qty > 0 && rate > 0 ? qty * rate : 0
                    return (
                      <tr key={`${i}-${row.description.slice(0, 20)}`}>
                        <td>{i + 1}</td>
                        <td>{row.product || '—'}</td>
                        <td>{row.description || '—'}</td>
                        <td>{row.qty}</td>
                        <td>{row.vendorUnitPrice ?? '—'}</td>
                        <td>{total > 0 ? formatInr(total) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>
                      Grand total (INR)
                    </td>
                    <td style={{ fontWeight: 700 }}>
                      {formatInr(
                        preview.lines.reduce((sum, row) => {
                          const qty = parseMoney(row.qty)
                          const rate = parseMoney(row.vendorUnitPrice)
                          if (qty <= 0 || rate <= 0) return sum
                          return sum + qty * rate
                        }, 0),
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="invoice-to-quote-page__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPreview(null)
                  setMessage(null)
                  if (inputRef.current) inputRef.current.value = ''
                }}
              >
                Choose another file
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleContinue}
              >
                Continue to quote
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
