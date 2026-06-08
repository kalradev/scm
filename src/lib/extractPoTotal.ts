import * as XLSX from 'xlsx'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
  if (!m?.[1]) throw new Error('Invalid attachment data.')
  const binary = atob(m[1])
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function parseInrLike(s: string): number | null {
  const cleaned = String(s).replace(/,/g, '').trim()
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

function cellToNumber(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell
  if (typeof cell === 'string') return parseInrLike(cell)
  return null
}

const LABEL_RE =
  /grand\s*total|total\s*amount|net\s*(?:payable|total)|amount\s*payable|^total$|po\s*amount|order\s*total|payable\s*amount/i

function pickClosestToQuote(candidates: number[], quoteTotal: number): number | null {
  const filtered = [...new Set(candidates)].filter((n) => n >= 100 && Number.isFinite(n))
  if (filtered.length === 0) return null
  const inBand = filtered.filter(
    (n) => n >= quoteTotal * 0.2 && n <= quoteTotal * 5,
  )
  const pool = inBand.length ? inBand : filtered
  let best = pool[0]
  let bestDiff = Math.abs(best - quoteTotal)
  for (const n of pool) {
    const d = Math.abs(n - quoteTotal)
    if (d < bestDiff) {
      best = n
      bestDiff = d
    }
  }
  return best
}

function extractFromSpreadsheet(buf: ArrayBuffer, quoteTotal: number): number | null {
  const wb = XLSX.read(buf, { type: 'array' })
  const labeled: number[] = []
  const all: number[] = []

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(
      sheet,
      { header: 1, defval: '', raw: false },
    )

    for (const row of rows) {
      if (!Array.isArray(row)) continue
      for (let c = 0; c < row.length; c++) {
        const raw = row[c]
        const label = String(raw ?? '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
        if (LABEL_RE.test(label)) {
          for (const off of [1, 2, -1, 3]) {
            const num = cellToNumber(row[c + off])
            if (num !== null && num > 0) labeled.push(num)
          }
        }
      }
    }

    for (const row of rows) {
      if (!Array.isArray(row)) continue
      for (const cell of row) {
        const num = cellToNumber(cell)
        if (num !== null && num >= 100) all.push(num)
      }
    }
  }

  if (labeled.length) {
    const best = pickClosestToQuote(labeled, quoteTotal)
    if (best !== null) return best
  }
  return pickClosestToQuote(all, quoteTotal)
}

async function extractFromPdf(buf: ArrayBuffer, quoteTotal: number): Promise<number | null> {
  const data = new Uint8Array(buf)
  const pdf = await pdfjsLib.getDocument({ data }).promise
  let text = ''
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    for (const item of tc.items) {
      if (item && typeof item === 'object' && 'str' in item && typeof item.str === 'string') {
        text += `${item.str} `
      }
    }
  }

  const amounts: number[] = []
  const re = /\b(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = parseInrLike(m[1])
    if (n !== null && n >= 100) amounts.push(n)
  }

  const nearTotal: number[] = []
  const lower = text.toLowerCase()
  const idx = lower.search(/grand\s*total|total\s*amount|net\s*payable|amount\s*payable/)
  if (idx !== -1) {
    const slice = text.slice(idx, idx + 120)
    let m2: RegExpExecArray | null
    const re2 = /\b(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\b/g
    while ((m2 = re2.exec(slice)) !== null) {
      const n = parseInrLike(m2[1])
      if (n !== null && n >= 100) nearTotal.push(n)
    }
  }

  const pool = nearTotal.length ? nearTotal : amounts
  return pickClosestToQuote(pool, quoteTotal)
}

export type ExtractPoTotalResult =
  | { ok: true; amountStr: string; amount: number }
  | { ok: false; message: string }

function formatAmountForStorage(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Tries to read a PO total from an uploaded PDF or spreadsheet (no OCR for images).
 */
export async function extractPoTotalFromAttachment(
  dataBase64DataUrl: string,
  fileName: string,
  mimeType: string,
  quoteTotalInr: number,
): Promise<ExtractPoTotalResult> {
  const lower = fileName.toLowerCase()

  try {
    const u8 = dataUrlToUint8Array(dataBase64DataUrl)
    const buf = u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer

    const isSheet =
      /\.(xlsx|xls|csv)$/i.test(lower) ||
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      mimeType === 'text/csv'

    const isPdf = /\.pdf$/i.test(lower) || mimeType.includes('pdf')

    if (isSheet) {
      const n = extractFromSpreadsheet(buf, quoteTotalInr)
      if (n === null) {
        return {
          ok: false,
          message:
            'Could not detect a total in this spreadsheet. Use a PDF PO, or enter the amount in “PO total” below.',
        }
      }
      return { ok: true, amountStr: formatAmountForStorage(n), amount: n }
    }

    if (isPdf) {
      const n = await extractFromPdf(buf, quoteTotalInr)
      if (n === null) {
        return {
          ok: false,
          message:
            'Could not read a total from this PDF’s text. Try Excel, or type the PO total below.',
        }
      }
      return { ok: true, amountStr: formatAmountForStorage(n), amount: n }
    }

    return {
      ok: false,
      message:
        'Automatic compare works with PDF or Excel PO files. For images, enter the PO total manually.',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not read the file.'
    return { ok: false, message: msg }
  }
}
