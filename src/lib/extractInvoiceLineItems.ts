import * as XLSX from 'xlsx'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** Parsed from invoice PDF/Excel — unit may be inferred when Qty × Unit ≈ Amount on the row. */
export type ExtractedInvoiceLine = {
  product: string
  description: string
  qty: string
  /** Vendor unit cost when parsed from a Unit × Qty ≈ Amount row. */
  vendorUnitPrice?: string
}

export type ExtractInvoiceLineItemsResult =
  | { ok: true; lines: ExtractedInvoiceLine[] }
  | { ok: false; message: string }

export type ExtractInvoiceLineItemsOptions = {
  /** 0–100 while OCR runs on a photo (best-effort). */
  onOcrProgress?: (percent: number) => void
}

const MAX_BYTES_SHEET_PDF = 8 * 1024 * 1024
/** Phone camera photos — OCR runs in the browser (first run may download language data). */
const MAX_BYTES_IMAGE = 12 * 1024 * 1024

function maxBytesForKind(kind: 'pdf' | 'sheet' | 'image'): number {
  return kind === 'image' ? MAX_BYTES_IMAGE : MAX_BYTES_SHEET_PDF
}

const RATE_HEADER =
  /^(rate|unit\s*rate|unit\s*price|u\.?rate|cost|price\/unit|list\s*price|net\s*rate|buying\s*rate|basic\s*rate|purchase\s*rate|mrp)$/i
const QTY_HEADER = /^(qty|quantity|qnty|qnt\.?|nos?\.?)$/i
const DESC_HEADER =
  /^(description|particulars|item\s*details?|details?|specification)$/i
const PRODUCT_HEADER = /^(item\s*name|product|material|sku|item)$/i
const SR_HEADER = /^(s\.?\s*r\.?|sl\.?\s*no|sr\.?\s*no|^#)$/i

const SKIP_ROW_LABEL =
  /grand\s*total|total\s*amount|net\s*total|sub\s*total|tax|gst|cgst|sgst|igst|hsn|amount|rate|balance|thank\s*you|invoice\s*no|bill\s*to/i

function normalizeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\u00a0/g, ' ').trim()
}

function parseQtyCell(raw: string): string {
  const s = raw.replace(/,/g, '').trim()
  if (!s) return ''
  const n = Number.parseFloat(s)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

function parseMoneyToken(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

function splitFirstTokenAsProduct(text: string): { product: string; description: string } {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const tokens = t.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { product: '', description: '' }
  const product = tokens[0].slice(0, 120)
  const description = (tokens.slice(1).join(' ').trim() || tokens[0]).slice(0, 500)
  return { product, description }
}

/**
 * When Qty × Unit = Amount, multiplication commutes so we cannot tell which of the two
 * middle numbers is quantity vs unit price from the product alone. Score both assignments.
 */
function pickQtyAndUnitFromAmountPair(
  a: number,
  b: number,
  amount: number,
): { qty: number; unit: number } | null {
  if (a <= 0 || b <= 0 || amount <= 0) return null
  const tol = Math.max(1, amount * 0.04)
  if (Math.abs(a * b - amount) > tol) return null

  const score = (qty: number, unit: number): number => {
    let s = 0
    if (qty > 5_000_000 || unit > 1e12) return -1e9

    const qtyWhole = Math.abs(qty - Math.round(qty)) < 1e-4
    if (qtyWhole && qty >= 1 && qty <= 100_000) s += 2
    if (!qtyWhole && qty < 1 && unit > 1) s += 1 // e.g. 0.5 kg @ 200

    const lo = Math.min(qty, unit)
    const hi = Math.max(qty, unit)
    if (hi >= lo * 20 && lo > 0) {
      if (qty === lo) s += 5
      else s -= 4
    }

    if (qty >= 10_000 && unit > 0 && unit <= 500 && hi / lo > 50) s -= 6
    if (unit >= qty * 2 && qty <= 10_000) s += 1

    return s
  }

  const sA = score(a, b)
  const sB = score(b, a)
  if (sA >= sB) return { qty: a, unit: b }
  return { qty: b, unit: a }
}

/**
 * Invoice table rows: often Description | Qty | Unit price | Amount, or Description | Unit | Qty | Amount.
 * Takes the **last three** numbers on the line so descriptions can include digits ("HP 522").
 * Keeps the row only when Amount ≈ Qty × Unit (within tolerance), then disambiguates qty vs unit.
 */
function tryParseTrailingThreeNumberInvoiceRow(raw: string): ExtractedInvoiceLine | null {
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (trimmed.length < 5) return null

  const matches: { val: number; index: number }[] = []
  const re = /\d[\d,]*(?:\.\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    const val = parseMoneyToken(m[0])
    if (!Number.isFinite(val)) continue
    matches.push({ val, index: m.index })
  }
  if (matches.length < 3) return null

  const last3 = matches.slice(-3)
  const left = last3[0].val
  const mid = last3[1].val
  const amt = last3[2].val

  const picked = pickQtyAndUnitFromAmountPair(left, mid, amt)
  if (!picked) return null

  let { qty: qtyNum, unit } = picked
  if (qtyNum > 500_000) return null

  const descEnd = last3[0].index
  let desc = trimmed.slice(0, descEnd).trim().replace(/[\s,;:]+$/, '')
  if (desc.length < 2) return null
  if (
    /^(subtotal|balance\s*due|total|less\s*deposit|invoice\s*no|date|due\b)/i.test(
      desc,
    )
  ) {
    return null
  }
  if (SKIP_ROW_LABEL.test(desc) && desc.length < 120) return null

  const qtyStr =
    Math.abs(qtyNum - Math.round(qtyNum)) < 1e-4 && qtyNum < 1e6
      ? String(Math.round(qtyNum))
      : String(qtyNum)

  const vendorUnitPrice =
    Math.abs(unit - Math.round(unit)) < 1e-6
      ? String(Math.round(unit))
      : String(Number(unit.toFixed(4)))

  const split = splitFirstTokenAsProduct(desc)
  return {
    product: split.product || 'Item',
    description: split.description || desc.slice(0, 500),
    qty: qtyStr,
    vendorUnitPrice,
  }
}

/** If PDF/OCR splits the table, the numeric triple may sit on the line after the description. */
function expandInvoiceLinesForSplitTableRows(lines: string[]): string[] {
  const base = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const extra: string[] = []
  for (let i = 0; i < base.length - 1; i++) {
    const next = base[i + 1]
    if (
      /^\d[\d,]*(?:\.\d+)?\s+\d[\d,]*(?:\.\d+)?\s+\d[\d,]*(?:\.\d+)?\s*$/.test(
        next,
      )
    ) {
      extra.push(`${base[i]} ${next}`.replace(/\s+/g, ' ').trim())
    }
  }
  return extra.length ? [...base, ...extra] : base
}

function parseLinesViaTrailingThreeNumbers(
  allLines: string[],
): ExtractedInvoiceLine[] {
  const candidates = expandInvoiceLinesForSplitTableRows(allLines)
  const out: ExtractedInvoiceLine[] = []
  for (const line of candidates) {
    const raw = line.replace(/\s+/g, ' ').trim()
    if (!raw || raw.length < 5) continue
    const row = tryParseTrailingThreeNumberInvoiceRow(raw)
    if (row) out.push(row)
  }
  return out
}

function scoreHeaderCell(cell: string): {
  sr: boolean
  product: boolean
  desc: boolean
  qty: boolean
  rate: boolean
} {
  const t = cell.toLowerCase().replace(/\s+/g, ' ').trim()
  return {
    sr: SR_HEADER.test(t),
    product: PRODUCT_HEADER.test(t),
    desc: DESC_HEADER.test(t),
    qty: QTY_HEADER.test(t),
    rate: RATE_HEADER.test(t),
  }
}

function extractFromSpreadsheet(buf: ArrayBuffer): ExtractedInvoiceLine[] {
  const wb = XLSX.read(buf, { type: 'array' })

  for (const sheetName of wb.SheetNames) {
    const sheetOut: ExtractedInvoiceLine[] = []
    const sheet = wb.Sheets[sheetName]
    if (!sheet['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(
      sheet,
      { header: 1, defval: '', raw: false },
    )

    let bestRow = -1
    let bestScore = 0
    let bestMap: {
      sr: number
      product: number
      desc: number
      qty: number
      rate: number
    } | null = null

    for (let r = 0; r < Math.min(rows.length, 80); r++) {
      const row = rows[r]
      if (!Array.isArray(row)) continue
      let sr = -1
      let product = -1
      let desc = -1
      let qty = -1
      let rate = -1
      let score = 0
      for (let c = 0; c < row.length; c++) {
        const cell = normalizeCell(row[c])
        if (!cell) continue
        const sc = scoreHeaderCell(cell)
        if (sc.qty && qty < 0) {
          qty = c
          score += 4
        }
        if (sc.desc && desc < 0) {
          desc = c
          score += 3
        }
        if (sc.rate && rate < 0) {
          rate = c
          score += 3
        }
        if (sc.product && product < 0) {
          product = c
          score += 2
        }
        if (sc.sr && sr < 0) {
          sr = c
          score += 1
        }
      }
      if (qty >= 0 && score > bestScore) {
        bestScore = score
        bestRow = r
        bestMap = { sr, product, desc, qty, rate }
      }
    }

    if (bestRow < 0 || !bestMap || bestMap.qty < 0) continue

    const { sr, product, desc, qty, rate } = bestMap
    const textCol =
      desc >= 0 ? desc : product >= 0 ? product : Math.max(0, qty - 1)
    const productCol = product >= 0 ? product : textCol

    for (let r = bestRow + 1; r < rows.length; r++) {
      const row = rows[r]
      if (!Array.isArray(row)) continue
      const joined = row.map((c) => normalizeCell(c)).join(' ').toLowerCase()
      if (!joined.trim()) continue
      if (SKIP_ROW_LABEL.test(joined) && row.filter((c) => normalizeCell(c)).length <= 4) {
        continue
      }

      const qtyStr = parseQtyCell(normalizeCell(row[qty]))
      if (!qtyStr) continue

      const descStr = normalizeCell(row[desc >= 0 ? desc : textCol])
      const prodStr = normalizeCell(
        row[productCol] !== undefined ? row[productCol] : row[textCol],
      )
      let description = desc >= 0 && product >= 0 && desc !== product ? descStr : descStr
      let productName =
        desc >= 0 && product >= 0 && desc !== product
          ? prodStr
          : descStr.slice(0, 80)

      if (!description && productName) {
        description = productName
        productName = description.split(/\s+/).slice(0, 4).join(' ') || 'Item'
      }
      if (!description && !productName) continue
      if (!productName) productName = description.slice(0, 60) || 'Item'

      if (sr >= 0) {
        const s = normalizeCell(row[sr])
        if (/^\d+$/.test(s) && !description && !productName) continue
      }

      let vendorUnitPrice: string | undefined
      if (rate >= 0 && row[rate] !== undefined) {
        const rawRate = normalizeCell(row[rate])
        const n = parseMoneyToken(rawRate)
        if (Number.isFinite(n) && n >= 0 && n < 1e12) {
          vendorUnitPrice =
            Math.abs(n - Math.round(n)) < 1e-6
              ? String(Math.round(n))
              : String(Number(n.toFixed(4)))
        }
      }

      sheetOut.push({
        product: productName.slice(0, 200),
        description: (description || productName).slice(0, 500),
        qty: qtyStr,
        ...(vendorUnitPrice ? { vendorUnitPrice } : {}),
      })
    }

    if (sheetOut.length) return sheetOut
  }

  return []
}

type PdfTextPiece = { str: string; x: number; y: number }

function pdfPageToLines(page: { getTextContent(): Promise<{ items: unknown[] }> }): Promise<string[]> {
  return page.getTextContent().then((tc) => {
    const pieces: PdfTextPiece[] = []
    for (const item of tc.items) {
      if (!item || typeof item !== 'object' || !('str' in item)) continue
      const it = item as { str: string; transform?: number[] }
      if (typeof it.str !== 'string' || !it.transform || it.transform.length < 6) continue
      const x = it.transform[4]
      const y = it.transform[5]
      const s = it.str.replace(/\u00a0/g, ' ').trim()
      if (!s) continue
      pieces.push({ str: s, x, y })
    }
    if (pieces.length === 0) return []

    const Y_BUCKET = 3
    const buckets = new Map<number, PdfTextPiece[]>()
    for (const p of pieces) {
      const key = Math.round(p.y / Y_BUCKET) * Y_BUCKET
      const arr = buckets.get(key) ?? []
      arr.push(p)
      buckets.set(key, arr)
    }
    const ys = [...buckets.keys()].sort((a, b) => b - a)
    const lines: string[] = []
    for (const y of ys) {
      const row = (buckets.get(y) ?? []).sort((a, b) => a.x - b.x)
      lines.push(row.map((p) => p.str).join(' '))
    }
    return lines
  })
}

function dedupeLines(lines: ExtractedInvoiceLine[]): ExtractedInvoiceLine[] {
  const seen = new Set<string>()
  const out: ExtractedInvoiceLine[] = []
  for (const L of lines) {
    const key = `${L.product}|${L.description}|${L.qty}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(L)
  }
  return out
}

/**
 * Some invoices use: `QTY | Item | Description | Cost` (no Amount column).
 * When PDF/OCR flattens the table, a row often looks like:
 * `5 dell 16 gb 256 hdd 20000`
 * Here "Cost" is the **unit price** (Subtotal matches Qty × Cost).
 */
function tryParseLeadingQtyTrailingCostRow(raw: string): ExtractedInvoiceLine | null {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (s.length < 6) return null
  if (SKIP_ROW_LABEL.test(s) && s.length < 120) return null

  const m = s.match(
    /^(\d{1,6}(?:\.\d{1,3})?)\s+(.+?)\s+(\d[\d,]*(?:\.\d{1,3})?)\s*$/,
  )
  if (!m) return null

  const qtyStr = parseQtyCell(m[1])
  if (!qtyStr) return null

  const text = String(m[2] ?? '').trim()
  if (text.length < 2) return null
  // Avoid lines that are basically numeric only (totals, page numbers, etc.)
  if (!/[a-z]/i.test(text)) return null

  // For `QTY | Item | Description | Cost` layouts the PDF text often flattens to:
  // `<qty> <item> <description...> <cost>`
  // Keep the first token as the "product/item" column and the rest as description.
  const split = splitFirstTokenAsProduct(text)
  const product = split.product
  const description = split.description

  const costNum = parseMoneyToken(m[3])
  if (!Number.isFinite(costNum) || costNum <= 0) return null
  if (costNum > 1e12) return null

  const vendorUnitPrice =
    Math.abs(costNum - Math.round(costNum)) < 1e-6
      ? String(Math.round(costNum))
      : String(Number(costNum.toFixed(4)))

  return {
    product: product || 'Item',
    description: description.slice(0, 500),
    qty: qtyStr,
    vendorUnitPrice,
  }
}

/** Shared by PDF text, OCR from photos, and similar plain-text layouts. */
function parseInvoiceLinesFromTextLines(allLines: string[]): ExtractedInvoiceLine[] {
  const viaTriple = parseLinesViaTrailingThreeNumbers(allLines)
  if (viaTriple.length > 0) {
    return dedupeLines(viaTriple)
  }

  let headerIndex = -1
  for (let i = 0; i < allLines.length; i++) {
    const low = allLines[i].toLowerCase()
    if (QTY_HEADER.test(low) || /\bqty\b|\bquantity\b/i.test(low)) {
      if (DESC_HEADER.test(low) || PRODUCT_HEADER.test(low) || low.length < 120) {
        headerIndex = i
        break
      }
    }
  }

  const out: ExtractedInvoiceLine[] = []
  const start = headerIndex >= 0 ? headerIndex + 1 : 0

  for (let i = start; i < allLines.length; i++) {
    const raw = allLines[i].replace(/\s+/g, ' ').trim()
    if (!raw || raw.length < 3) continue
    if (SKIP_ROW_LABEL.test(raw) && raw.length < 100) continue

    // `QTY ... COST` rows (no Amount column).
    const qtyCost = tryParseLeadingQtyTrailingCostRow(raw)
    if (qtyCost) {
      out.push(qtyCost)
      continue
    }

    const mEndQty = raw.match(
      /^(\d{1,3})\s+(.+?)\s+(\d{1,6}(?:\.\d{1,3})?)\s*$/,
    )
    if (mEndQty) {
      const text = mEndQty[2].trim()
      const q = parseQtyCell(mEndQty[3])
      if (q && text.length >= 2 && !/^(total|page|of)\b/i.test(text)) {
        out.push({
          product: text.split(/\s+/).slice(0, 5).join(' ').slice(0, 120) || 'Item',
          description: text.slice(0, 500),
          qty: q,
        })
      }
      continue
    }

    const parts = raw.split(/\s{2,}|\t+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 3) {
      const last = parts[parts.length - 1]
      const q = parseQtyCell(last.replace(/,/g, ''))
      if (q) {
        const textParts = parts.slice(0, -1)
        const first = textParts[0] ?? ''
        if (/^\d{1,3}$/.test(first)) {
          textParts.shift()
        }
        const text = textParts.join(' ').trim()
        if (text.length >= 3) {
          out.push({
            product: text.split(/\s+/).slice(0, 5).join(' ').slice(0, 120) || 'Item',
            description: text.slice(0, 500),
            qty: q,
          })
        }
      }
    }
  }

  return dedupeLines(out)
}

const PDF_OCR_MAX_PAGES = 3

async function ocrPdfToPlainText(
  pdf: PDFDocumentProxy,
  onProgress?: (pct: number) => void,
): Promise<string> {
  if (typeof document === 'undefined') return ''
  const { createWorker } = await import('tesseract.js')
  const pageCount = Math.min(pdf.numPages, PDF_OCR_MAX_PAGES)
  const ocrPageState = { current: 1, total: pageCount }
  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status !== 'recognizing text' || typeof m.progress !== 'number') return
      const { current, total } = ocrPageState
      const overall = ((current - 1 + m.progress) / total) * 100
      onProgress?.(Math.min(100, Math.round(overall)))
    },
  })
  const parts: string[] = []
  try {
    for (let p = 1; p <= pageCount; p++) {
      ocrPageState.current = p
      const page = await pdf.getPage(p)
      const base = page.getViewport({ scale: 1 })
      const maxSide = 2000
      const scale = Math.min(2.5, maxSide / Math.max(base.width, base.height, 1))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue

      const task = page.render({ canvas, viewport })
      await task.promise

      const blob: Blob | null = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png')
      })
      if (!blob) continue

      const {
        data: { text },
      } = await worker.recognize(blob)
      parts.push(text)
    }
  } finally {
    await worker.terminate()
  }
  return parts.join('\n')
}

/** Rasterize PDF pages and OCR them (for scanned / image-only PDFs). Browser-only. */
async function extractPdfPagesViaOcr(
  pdf: PDFDocumentProxy,
  onProgress?: (pct: number) => void,
): Promise<ExtractedInvoiceLine[]> {
  if (typeof document === 'undefined') return []

  const merged = await ocrPdfToPlainText(pdf, onProgress)
  const rawLines = merged
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
  return parseInvoiceLinesFromTextLines(rawLines)
}

async function extractFromPdf(
  buf: ArrayBuffer,
  onProgress?: (pct: number) => void,
): Promise<ExtractedInvoiceLine[]> {
  const data = new Uint8Array(buf)
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const allLines: string[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const lines = await pdfPageToLines(page)
    allLines.push(...lines)
  }

  const fromText = parseInvoiceLinesFromTextLines(allLines)
  if (fromText.length > 0) return fromText

  return extractPdfPagesViaOcr(pdf, onProgress)
}

async function extractFromImage(
  buf: ArrayBuffer,
  mimeType: string,
  onProgress?: (pct: number) => void,
): Promise<ExtractedInvoiceLine[]> {
  const { createWorker } = await import('tesseract.js')
  const mt =
    mimeType && mimeType !== 'application/octet-stream' ? mimeType : 'image/jpeg'
  const blob = new Blob([buf], { type: mt })
  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(Math.min(100, Math.round(m.progress * 100)))
      }
    },
  })
  try {
    const {
      data: { text },
    } = await worker.recognize(blob)
    const rawLines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0)
    return parseInvoiceLinesFromTextLines(rawLines)
  } finally {
    await worker.terminate()
  }
}

/**
 * Filename wins when present (browsers often omit MIME). Photos → OCR in-browser.
 */
export function classifyImportKind(file: File): 'pdf' | 'sheet' | 'image' | null {
  const name = (file.name || '').trim().toLowerCase()
  const mime = (file.type || '').trim().toLowerCase()

  if (/\.(xlsx|xls|csv|tsv)$/i.test(name)) return 'sheet'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.(jpe?g|png|gif|webp|bmp|tif|tiff|heic|heif|avif)$/i.test(name)) return 'image'

  if (mime.startsWith('image/')) return 'image'
  if (mime.includes('pdf')) return 'pdf'
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime.includes('csv') ||
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values' ||
    mime === 'text/plain' ||
    mime === 'application/csv' ||
    mime === 'application/vnd.ms-excel'
  ) {
    return 'sheet'
  }

  if (!mime || mime === 'application/octet-stream') return null
  return null
}

function spreadsheetBufToPlainText(buf: ArrayBuffer): string {
  const wb = XLSX.read(buf, { type: 'array' })
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(
      sheet,
      { header: 1, defval: '', raw: false },
    )
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const cells = row.map((c) => normalizeCell(c)).filter(Boolean)
      if (cells.length) parts.push(cells.join(' '))
    }
  }
  return parts.join('\n')
}

/**
 * Customer PO party extraction needs the buyer side; many POs are "grid" sheets with seller on the
 * right and buyer on the left. When flattened, both sides merge and seller text causes us to drop
 * the whole line. This helper reads only the left-most columns to preserve buyer blocks.
 */
function spreadsheetBufToPlainTextLeftColumns(
  buf: ArrayBuffer,
  maxCols: number,
): string {
  const wb = XLSX.read(buf, { type: 'array' })
  const parts: string[] = []
  const cols = Math.max(1, Math.min(8, Math.floor(maxCols || 1)))
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(
      sheet,
      { header: 1, defval: '', raw: false },
    )
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const left = row.slice(0, cols).map((c) => normalizeCell(c)).filter(Boolean)
      if (!left.length) continue

      // If the buyer block is in a single multi-line cell (common for Address), preserve line breaks
      // so downstream "block" parsers can detect multi-line addresses.
      if (left.length === 1) {
        const cellLines = left[0]
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean)
        if (cellLines.length >= 2) {
          parts.push(...cellLines)
          continue
        }
      }

      // Otherwise, flatten the row into one line (keeps PO# + buyer name on the same row).
      const joined = left
        .flatMap((c) => c.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))
        .join(' ')
        .trim()
      if (joined) parts.push(joined)
    }
  }
  return parts.join('\n')
}

async function pdfBufToPlainTextWithOcrFallback(buf: ArrayBuffer): Promise<string> {
  const data = new Uint8Array(buf)
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const allLines: string[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const lines = await pdfPageToLines(page)
    allLines.push(...lines)
  }
  const joined = allLines.join('\n').trim()
  // If the PDF is scanned/image-only, text extraction yields almost nothing.
  if (joined.length >= 80) return joined
  const ocr = await ocrPdfToPlainText(pdf)
  return ocr.trim() || joined
}

async function imageBufToPlainText(buf: ArrayBuffer, mimeType: string): Promise<string> {
  const { createWorker } = await import('tesseract.js')
  const mt =
    mimeType && mimeType !== 'application/octet-stream' ? mimeType : 'image/jpeg'
  const blob = new Blob([buf], { type: mt })
  const worker = await createWorker('eng', 1)
  try {
    const {
      data: { text },
    } = await worker.recognize(blob)
    return text
  } finally {
    await worker.terminate()
  }
}

/** Full document text for footer parsing (balance due, deposits). Ignores line-item table rules. */
export async function extractInvoiceRawTextForFooterScan(file: File): Promise<string> {
  const kind = classifyImportKind(file)
  if (!kind) return ''
  const limit = maxBytesForKind(kind)
  if (file.size > limit) return ''
  try {
    const buf = await file.arrayBuffer()
    if (kind === 'sheet') return spreadsheetBufToPlainText(buf)
    if (kind === 'pdf') return await pdfBufToPlainTextWithOcrFallback(buf)
    return await imageBufToPlainText(buf, file.type || 'image/jpeg')
  } catch {
    return ''
  }
}

/**
 * PO party extraction: prefer buyer-side spreadsheet columns to avoid seller leakage in grid POs.
 */
export async function extractPoRawTextForPartyScan(file: File): Promise<string> {
  const kind = classifyImportKind(file)
  if (!kind) return ''
  const limit = maxBytesForKind(kind)
  if (file.size > limit) return ''
  try {
    const buf = await file.arrayBuffer()
    if (kind === 'sheet') return spreadsheetBufToPlainTextLeftColumns(buf, 3)
    if (kind === 'pdf') return await pdfBufToPlainTextWithOcrFallback(buf)
    return await imageBufToPlainText(buf, file.type || 'image/jpeg')
  } catch {
    return ''
  }
}

/**
 * Best-effort line items from invoice files or spreadsheets (description, qty, parsed unit when
 * trailing numbers satisfy Qty × Unit ≈ Amount). Photos use OCR (English).
 */
export async function extractInvoiceLineItemsFromFile(
  file: File,
  options?: ExtractInvoiceLineItemsOptions,
): Promise<ExtractInvoiceLineItemsResult> {
  const kind = classifyImportKind(file)
  const limit = kind !== null ? maxBytesForKind(kind) : MAX_BYTES_IMAGE
  if (file.size > limit) {
    return {
      ok: false,
      message: `File is too large (max ${Math.round(limit / 1024)} KB).`,
    }
  }

  if (kind === null) {
    return {
      ok: false,
      message:
        'Use Excel (.xlsx, .xls), CSV/TSV, PDF, or a photo (JPG, PNG, …). Rename the file with the correct extension if your browser did not detect the type.',
    }
  }

  try {
    const buf = await file.arrayBuffer()
    let lines: ExtractedInvoiceLine[] = []
    if (kind === 'sheet') {
      lines = extractFromSpreadsheet(buf)
    } else if (kind === 'pdf') {
      lines = await extractFromPdf(buf, options?.onOcrProgress)
    } else {
      lines = await extractFromImage(buf, file.type || 'image/jpeg', options?.onOcrProgress)
    }

    lines = dedupeLines(lines.filter((L) => L.description.trim() || L.product.trim()))

    if (lines.length === 0) {
      const sheetMsg =
        'Could not find a quantity + description table. Use a header row with columns like Description and Qty (or Quantity), then data rows below.'
      const pdfMsg =
        'Could not find line items in this PDF (including after scanning the pages). Try Excel (.xlsx), export a text-based PDF, upload a photo of the invoice, or add lines manually on the quote.'
      const photoMsg =
        'Could not read line items from this photo. Use a sharper, well-lit image, try Excel/PDF export, or enter lines manually on the quote.'
      return {
        ok: false,
        message:
          kind === 'sheet' ? sheetMsg : kind === 'image' ? photoMsg : pdfMsg,
      }
    }

    return { ok: true, lines }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not read the file.'
    return { ok: false, message: msg }
  }
}
