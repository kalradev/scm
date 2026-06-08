import * as XLSX from 'xlsx'
import type { OvfProofAttachment } from '../types/ovf'
import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'
import type { QuotePoState } from '../types/quotePo'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import { filterCommercialLines } from './quoteLineItems'
import { lineAmount, recipientDisplayLine } from './quotePdfTemplate'
import { getSenderPdfContent } from './senderAddresses'
import { isIdbBase64Ref, resolveAttachmentBase64 } from './attachmentIdb'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function parseQty(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Single “Item Description” cell (same line items as the PDF table). */
function itemDescriptionCell(line: QuoteLineForm): string {
  const p = (line.product || '').trim()
  const d = (line.description || '').trim()
  if (p && d) return `${p}\n${d}`
  return p || d || '—'
}

/** Split terms into numbered rows (Excel-style Sr. No. + text). Preserves existing “1. …” numbering. */
function termsTableRows(termsRaw: string): { sr: string; text: string }[] {
  const lines = String(termsRaw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const out: { sr: string; text: string }[] = []
  let auto = 1
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s*(.*)$/)
    if (m && m[1] && m[2] !== undefined) {
      out.push({ sr: m[1], text: m[2].trim() || line })
    } else {
      out.push({ sr: String(auto), text: line })
      auto++
    }
  }
  return out
}

/**
 * Same grid as the PDF: client block, letterhead lines, Commercial table, Terms.
 */
function buildQuoteExportRows(data: QuoteFormData): string[][] {
  const lines = filterCommercialLines(data.lineItems)
  const total = lines.reduce((sum, line) => sum + lineAmount(line), 0)

  const sender = getSenderPdfContent(
    data.senderAddressPreset,
    data.quoteDate,
    data.quoteRef,
    data.validUntil,
  )

  const rows: string[][] = []

  const recipient = recipientDisplayLine(data.customerName).trim()
  if (recipient) {
    rows.push(['Recipient', recipient, '', '', ''])
  }

  const company = String(data.customerCompanyName ?? '').trim()
  if (company) {
    rows.push(['Company name', company, '', '', ''])
  }

  const addr = String(data.customerAddress ?? '').trim()
  if (addr) {
    for (const part of addr.split(/\r?\n/)) {
      const row = part.trim()
      if (row) rows.push(['Address', row, '', '', ''])
    }
  }

  const subj = String(data.subject ?? '').trim()
  if (subj) {
    rows.push(['Sub', subj, '', '', ''])
  }

  rows.push(['', '', '', '', ''])

  for (const hl of sender.headerLines) {
    rows.push([hl.text, '', '', '', ''])
  }

  rows.push(['', '', '', '', ''])
  rows.push(['Commercial', '', '', '', ''])
  rows.push([
    'Sr. No.',
    'Item Description',
    'Qty',
    'Unit Price(INR)',
    'Total Price(INR)',
  ])

  lines.forEach((line, i) => {
    const qty = parseQty(line.qty)
    const unit = parseMoney(line.unitPrice)
    const lineTotal = lineAmount(line)
    rows.push([
      String(i + 1),
      itemDescriptionCell(line),
      String(qty),
      formatInr(unit),
      formatInr(lineTotal),
    ])
  })

  rows.push(['', '', '', 'Grand Total', formatInr(total)])

  rows.push(['', '', '', '', ''])
  rows.push(['Sr. No.', 'Terms and Conditions', '', '', ''])

  const termRows = termsTableRows(data.termsAndConditions ?? '')
  if (termRows.length === 0) {
    rows.push(['—', '—', '', '', ''])
  } else {
    for (const tr of termRows) {
      rows.push([tr.sr, tr.text, '', '', ''])
    }
  }

  return rows
}

/** Column widths so Excel does not show #### for wide INR amounts. */
function columnWidthsForRows(rows: string[][]): XLSX.ColInfo[] {
  const n = 5
  const wch = Array(n).fill(12) as number[]
  for (const row of rows) {
    for (let c = 0; c < n; c++) {
      const cell = String(row[c] ?? '')
      const lines = cell.split(/\r?\n/)
      const maxLine = Math.max(1, ...lines.map((l) => l.length))
      wch[c] = Math.max(wch[c], Math.min(maxLine + 2, 55))
    }
  }
  wch[0] = Math.max(wch[0], 10)
  wch[1] = Math.max(wch[1], 28)
  wch[2] = Math.max(wch[2], 8)
  wch[3] = Math.max(wch[3], 18)
  wch[4] = Math.max(wch[4], 20)
  return wch.map((w) => ({ wch: w }))
}

/**
 * Excel workbook (.xlsx) with column widths — avoids #### when opening in Excel
 * (plain CSV cannot store column width).
 */
export function buildQuoteExcelBlob(
  raw: QuoteFormData & { customerTitle?: string },
): { blob: Blob; filename: string } {
  const data = normalizeQuoteFormData(raw)
  const rows = buildQuoteExportRows(data)
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = columnWidthsForRows(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Quote')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const safe = data.quoteRef.replace(/[^\w-]+/g, '_') || 'quote'
  return { blob, filename: `${safe}.xlsx` }
}

export function downloadQuoteExcelFromForm(
  raw: QuoteFormData & { customerTitle?: string },
) {
  const { blob, filename } = buildQuoteExcelBlob(raw)
  triggerDownload(blob, filename)
}

function escapeCsvCell(s: string): string {
  const t = String(s ?? '')
  if (/[",\r\n]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`
  }
  return t
}

/** Same row grid as Excel/PDF; UTF-8 with BOM for Excel compatibility. */
export function downloadQuoteCsvFromForm(
  raw: QuoteFormData & { customerTitle?: string },
) {
  const data = normalizeQuoteFormData(raw)
  const rows = buildQuoteExportRows(data)
  const lines = rows.map((row) =>
    row.map((cell) => escapeCsvCell(String(cell ?? ''))).join(','),
  )
  const csv = '\uFEFF' + lines.join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const safe = data.quoteRef.replace(/[^\w-]+/g, '_') || 'quote'
  triggerDownload(blob, `${safe}.csv`)
}

export function downloadBlob(blob: Blob, filename: string) {
  triggerDownload(blob, filename)
}

/**
 * Excel/CSV (and similar) attachments can't be previewed in-browser.
 * Returns a hint so the UI can offer “save & open on PC” (e.g. Excel on Windows).
 */
export function spreadsheetAttachmentKind(
  blob: Blob,
  fileLabel: string,
): 'excel' | 'csv' | null {
  const name = (fileLabel || '').toLowerCase()
  const ty = (blob.type || '').toLowerCase()
  if (
    name.endsWith('.csv') ||
    ty === 'text/csv' ||
    ty === 'application/csv'
  ) {
    return 'csv'
  }
  if (
    /\.(xlsx|xlsm|xls|xltx|xltm)$/.test(name) ||
    ty.includes('spreadsheetml') ||
    ty.includes('ms-excel') ||
    ty === 'application/vnd.ms-excel'
  ) {
    return 'excel'
  }
  return null
}

/**
 * Lets the user pick a save location (Chromium/Edge) then writes the file so they can open it
 * in Excel from File Explorer. Falls back to a normal download elsewhere or on errors.
 * Does nothing extra if the user cancels the picker (AbortError).
 */
export async function saveBlobForDesktopOpen(blob: Blob, filename: string): Promise<void> {
  const safe = filename.trim() || 'download'

  const win = window as Window & {
    showSaveFilePicker?: (options?: {
      suggestedName?: string
    }) => Promise<FileSystemFileHandle>
  }

  if (typeof win.showSaveFilePicker === 'function') {
    try {
      const handle = await win.showSaveFilePicker({ suggestedName: safe })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (e: unknown) {
      const name =
        e && typeof e === 'object' && 'name' in e
          ? String((e as { name: string }).name)
          : ''
      if (name === 'AbortError') return
    }
  }

  downloadBlob(blob, safe)
}

/** Decode stored proof/PO payloads (plain base64 or `data:mime;base64,…`). */
function rawBase64AndMime(payload: string): { base64: string; mime: string } {
  const s = String(payload ?? '').trim()
  if (s.startsWith('data:')) {
    const semi = s.indexOf(';base64,')
    if (semi !== -1) {
      const mime =
        s.slice(5, semi).trim() ||
        'application/octet-stream'
      return { mime, base64: s.slice(semi + ';base64,'.length) }
    }
  }
  return { base64: s, mime: 'application/octet-stream' }
}

export function proofAttachmentBlob(att: OvfProofAttachment): Blob {
  const { base64, mime } = rawBase64AndMime(att.dataBase64)
  if (isIdbBase64Ref(base64)) {
    throw new Error('attachment_idb_ref')
  }
  const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bin], { type: att.mimeType || mime })
}

export async function proofAttachmentBlobAsync(att: OvfProofAttachment): Promise<Blob> {
  const { base64, mime } = rawBase64AndMime(att.dataBase64)
  const resolved = await resolveAttachmentBase64(base64)
  const bin = Uint8Array.from(atob(resolved), (c) => c.charCodeAt(0))
  return new Blob([bin], { type: att.mimeType || mime })
}

export function quotePoBlob(po: QuotePoState): Blob {
  const { base64, mime } = rawBase64AndMime(po.dataBase64)
  const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bin], { type: po.mimeType || mime })
}

export function downloadProofAttachment(att: OvfProofAttachment) {
  const blob = proofAttachmentBlob(att)
  const safe = String(att.fileName || 'attachment').replace(/[^\w.-]+/g, '_')
  triggerDownload(blob, safe)
}

export function downloadQuotePoAttachment(po: QuotePoState) {
  const blob = quotePoBlob(po)
  const safe = String(po.fileName || 'customer-po').replace(/[^\w.-]+/g, '_')
  triggerDownload(blob, safe)
}
