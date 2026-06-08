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

function sanitizePoRef(raw: string): string | null {
  let s = String(raw).replace(/\u00a0/g, ' ').trim()
  s = s.replace(/^\[+/, '').replace(/\]+$/, '')
  s = s.replace(/^['"“”‘’]+|['"“”‘’]+$/g, '').trim()
  if (s.length < 2 || s.length > 64) return null
  if (/^(date|total|amount|page|of|ship\s*to|bill\s*to|qty|quantity)$/i.test(s)) {
    return null
  }
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(s)) return null
  if (!/[A-Za-z0-9]/.test(s)) return null
  return s
}

/** Heuristic: PO # / PO No / Customer PO labels followed by a reference token. */
export function extractPoNumberFromPlainText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const patterns = [
    /customer\s*po\s*(?:#|no\.?|number|ref\.?)?\s*[：:\s]*\[?\s*([A-Za-z0-9][^\]\s\n\r,;]{0,62})\]?/gi,
    /\bpo\s*#\s*[：:\s]*\[?\s*([A-Za-z0-9][^\]\s\n\r,;]{0,62})\]?/gi,
    /\bp\.?\s*o\.?\s*(?:#|no\.?|number)\s*[：:\s]*\[?\s*([A-Za-z0-9][^\]\s\n\r,;]{0,62})\]?/gi,
    /\border\s*(?:#|no\.?|number)\s*[：:\s]*\[?\s*([A-Za-z0-9][^\]\s\n\r,;]{0,62})\]?/gi,
    /\b(?:purchase\s*order)\s*(?:no\.?|number|#)?\s*[：:\s]*\[?\s*([A-Za-z0-9\/\-][^\]\s\n\r,;]{0,62})\]?/gi,
    /\b(?:document|doc)\s*(?:no\.?|number|ref\.?)?\s*[：:\s]*\[?\s*([A-Za-z0-9\/\-][^\]\s\n\r,;]{0,62})\]?/gi,
    /\b(?:our\s*)?(?:ref|reference)\s*(?:no\.?)?\s*[：:\s]*\[?\s*([A-Za-z0-9\/\-][^\]\s\n\r,;]{0,62})\]?/gi,
    /\bPO[\/\-]\s*([A-Z0-9][A-Za-z0-9\/\-]{1,40})\b/gi,
    /\bP\.?\s*O\.?\s*[\/\-]\s*([A-Za-z0-9][A-Za-z0-9\/\-]{0,40})\b/gi,
    /\bPO\s*[-–]\s*(\d{3,})\b/gi,
    /\b(PO\s*[-–]\s*\d+)\b/gi,
    /\bpo\s*(?:number|no\.?)\s*[：:\s]+([A-Za-z0-9][A-Za-z0-9\/\-]{1,40})\b/gi,
    /\b(?:your\s*)?(?:po|order)\s*(?:ref|reference)\s*[：:\s]+([A-Za-z0-9][A-Za-z0-9\/\-]{1,40})\b/gi,
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(normalized)) !== null) {
      const cand = sanitizePoRef(m[1])
      if (cand) return cand
    }
  }
  // Loose: refs like QT-2026-013 / PO-ABC-001 after PO/Purchase wording on same general area
  const loose = normalized.match(
    /\b(?:purchase\s*order|customer\s*p\.?\s*o\.?)\b[\s\S]{0,180}?([A-Z]{2,}[\-/]\d{4}[\-/]\d{2,8})\b/i,
  )
  if (loose?.[1]) {
    const cand = sanitizePoRef(loose[1])
    if (cand) return cand
  }
  return null
}

function cellHasPoLabel(s: unknown): boolean {
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return false
  if (/^customer\s*po(\s*#|\s*no\.?|\s*number|\s*ref)?$/i.test(t)) return true
  if (/^po\s*#$/i.test(t)) return true
  if (/^p\.?\s*o\.?\s*(#|no\.?|number)$/i.test(t)) return true
  if (/^po$/i.test(t)) return true
  return false
}

function extractFromSpreadsheet(buf: ArrayBuffer): string | null {
  const wb = XLSX.read(buf, { type: 'array' })
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
        if (!cellHasPoLabel(row[c])) continue
        for (const off of [1, 2, 3, -1]) {
          const cell = row[c + off]
          const raw = cell === undefined || cell === null ? '' : String(cell).trim()
          const cand = sanitizePoRef(raw)
          if (cand) return cand
        }
      }
    }
  }
  const joined = wb.SheetNames.map((n) => {
    const s = wb.Sheets[n]
    return XLSX.utils.sheet_to_csv(s, { FS: ' ', RS: '\n' })
  }).join('\n')
  return extractPoNumberFromPlainText(joined)
}

async function extractFromPdf(buf: ArrayBuffer): Promise<string | null> {
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
  return extractPoNumberFromPlainText(text)
}

export type ExtractPoNumberResult =
  | { ok: true; poNumber: string }
  | { ok: false; message: string }

/**
 * Best-effort customer PO reference from PDF or spreadsheet text (no OCR for images).
 */
export async function extractPoNumberFromAttachment(
  dataBase64DataUrl: string,
  fileName: string,
  mimeType: string,
): Promise<ExtractPoNumberResult> {
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
      const n = extractFromSpreadsheet(buf)
      if (n === null) {
        return {
          ok: false,
          message:
            'Could not find a PO number in this spreadsheet. Enter “Customer PO number” manually.',
        }
      }
      return { ok: true, poNumber: n }
    }

    if (isPdf) {
      const n = await extractFromPdf(buf)
      if (n === null) {
        return {
          ok: false,
          message:
            'Could not find a PO # in this PDF’s text. Enter the customer PO number manually, or try Excel.',
        }
      }
      return { ok: true, poNumber: n }
    }

    return {
      ok: false,
      message:
        'PO number is read from PDF or Excel text only. For image POs, type the customer PO number below.',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not read the file.'
    return { ok: false, message: msg }
  }
}
