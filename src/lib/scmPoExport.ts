import ExcelJS from 'exceljs'
import {
  listOvfFinanceApprovedForScm,
  listSavedQuotesWithScmPo,
  type SavedQuoteRecord,
} from './savedQuotesStorage'
import { getCompanyLocationById } from './companyLocations'
import { computeLineTotalInr, normalizeScmPoLine } from './scmPoLine'
import { lineItemsExportSummary, mergeScmPoGapsFromOvfAndQuote } from './scmPoOvfCoalesce'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import type { QuoteFormData } from '../types/quotePdf'

const MAX_COL_WIDTH = 55
const MIN_COL_WIDTH = 9
const MAX_ROW_HEIGHT = 200

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Optional cover sheet + metadata; only used when the user runs export from the UI. */
export type ScmExportOptions = {
  /** Shown on the "Export cover" sheet (e.g. daily run name). */
  reportTitle?: string
  /** Free text, wrapped in the workbook. */
  notes?: string
  /** Usually the SCM user’s name. */
  preparedBy?: string
}

function localExportFilename(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `scm-po-export-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.xlsx`
}

function addExportCoverSheet(
  book: ExcelJS.Workbook,
  opts: ScmExportOptions & {
    poCount: number
    lineRowCount: number
    ovfIndexCount: number
    /** Same name as the browser download (one timestamp for cover + file). */
    fileName: string
  },
) {
  const sh = book.addWorksheet('Export cover', {
    properties: { defaultRowHeight: 20, defaultColWidth: 12 },
  })
  sh.getColumn(1).width = 26
  sh.getColumn(2).width = 68

  const labelStyle = (cell: ExcelJS.Cell) => {
    cell.font = { bold: true, color: { argb: 'FF334155' } }
  }

  sh.getCell('A1').value = 'SCM — PO & OVF export'
  sh.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0F172A' } }
  sh.getCell('B1').value = (opts.reportTitle || '').trim() || '—'
  sh.getCell('B1').alignment = { wrapText: true, vertical: 'top' }
  sh.getRow(1).height = 26

  sh.getCell('A2').value = 'Generated (this device)'
  labelStyle(sh.getCell('A2'))
  sh.getCell('B2').value = new Date().toLocaleString('en-IN', {
    dateStyle: 'long',
    timeStyle: 'short',
  })

  sh.getCell('A3').value = 'Prepared by'
  labelStyle(sh.getCell('A3'))
  sh.getCell('B3').value = (opts.preparedBy || '').trim() || '—'

  sh.getCell('A4').value = 'Data source'
  labelStyle(sh.getCell('A4'))
  sh.getCell('B4').value =
    'Current browser’s saved quotes / OVFs / POs (client-side). Re-export after more POs are saved to include them.'

  sh.getCell('A5').value = 'Snapshot rows'
  labelStyle(sh.getCell('A5'))
  sh.getCell('A5').font = { bold: true, size: 12, color: { argb: 'FF334155' } }
  sh.getRow(5).height = 20

  sh.getCell('A6').value = 'PO records (SCM data)'
  labelStyle(sh.getCell('A6'))
  sh.getCell('B6').value = opts.poCount
  sh.getCell('B6').alignment = { horizontal: 'right' }
  sh.getCell('A7').value = 'PO line rows (all lines)'
  labelStyle(sh.getCell('A7'))
  sh.getCell('B7').value = opts.lineRowCount
  sh.getCell('B7').alignment = { horizontal: 'right' }
  sh.getCell('A8').value = 'OVF index rows (finance-approved)'
  labelStyle(sh.getCell('A8'))
  sh.getCell('B8').value = opts.ovfIndexCount
  sh.getCell('B8').alignment = { horizontal: 'right' }

  sh.getCell('A9').value = 'File name'
  labelStyle(sh.getCell('A9'))
  sh.getCell('B9').value = opts.fileName
  sh.getCell('B9').alignment = { wrapText: true, vertical: 'top' }

  const notes = (opts.notes || '').trim()
  if (notes) {
    sh.getCell('A11').value = 'Your notes (included in this file)'
    labelStyle(sh.getCell('A11'))
    sh.getCell('A11').alignment = { vertical: 'top' }
    const c = sh.getCell('B11')
    c.value = notes
    c.alignment = { wrapText: true, vertical: 'top' }
    const lines = Math.max(2, Math.min(20, notes.split('\n').length + 1))
    sh.getRow(11).height = 16 * lines
  }

  sh.getCell('A12').value = 'Next steps'
  labelStyle(sh.getCell('A12'))
  sh.getCell('B12').value =
    'Open the other sheets: SCM POs, PO line items, OVF index. Use Save / Download in the app so each file name includes the date and time of export.'
  sh.getCell('B12').alignment = { wrapText: true, vertical: 'top' }
  sh.getRow(12).height = 48
}

/** ISO or plain date string → YYYY-MM-DD; empty in → empty out */
function toYyyyMmDd(raw: string | undefined | null): string {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const t = Date.parse(s)
  if (Number.isNaN(t)) return s
  return new Date(t).toISOString().slice(0, 10)
}

/** "PO updated at" → YYYY-MM-DD (no time) for a consistent grid */
function toDisplayDateTime(raw: string | undefined | null): string {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s) return ''
  if (s.includes('T') && s.length >= 10) {
    return toYyyyMmDd(s)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const t = Date.parse(s)
  if (Number.isNaN(t)) return s
  return toYyyyMmDd(s)
}

function parseNumericCell(raw: string | number | undefined | null): number | string {
  if (raw == null || raw === '') return ''
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const t = String(raw).replace(/,/g, '').replace(/^\s*₹\s*/i, '').trim()
  if (t === '') return ''
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : String(raw)
}

function cellString(value: ExcelJS.CellValue | undefined | null): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'result' in value) return String((value as { result: unknown }).result)
  if (typeof value === 'object' && 'text' in value) return String((value as { text: string }).text)
  return ''
}

function buildColumnWidths(
  headerRow: (string | number)[],
  dataRows: (string | number)[][],
): number[] {
  return headerRow.map((h, col) => {
    const headerLen = String(h).length
    let w = headerLen
    for (const row of dataRows) {
      const v = row[col] ?? ''
      const str = v === null || v === undefined ? '' : String(v)
      for (const line of str.split(/\n/)) {
        w = Math.max(w, line.length)
      }
    }
    return Math.min(Math.max(w * 0.9 + 2, MIN_COL_WIDTH) + 0.5, MAX_COL_WIDTH)
  })
}

const PO_HEADERS = [
  'Quote record id',
  'PO number',
  'PO status',
  'PO updated at',
  'Vendor (PO)',
  'Vendor address (PO)',
  'Source of supply',
  'Destination of supply',
  'Ship-from location',
  'Purchase date',
  'Delivery date',
  'Payment terms (days)',
  'OVF number',
  'Quote number',
  'Company PO number',
  'Customer PO number',
  'Customer PO date',
  'OVF approver',
  'Customer name',
  'Line items (summary)',
  'OVF margin',
  'OVF margin %',
  'OVF vendor (snapshot)',
  'OVF billing state',
  'OVF shipping address',
] as const

const PO_COL_WRAP0 = new Set([0, 4, 5, 6, 7, 8, 14, 17, 18, 19, 22, 23, 24])
const PO_COL_NUM0 = new Set([11, 20, 21]) // pay days, margin, margin %

const LINE_COL_WRAP0 = new Set([0, 1, 3, 4, 5])
const LINE_COL_NUM0 = new Set([2, 7, 8, 9, 10])
const OVF_COL_WRAP0 = new Set([0, 1, 2, 3, 4, 5, 6, 7])
const OVF_COL_NUM0 = new Set([8, 9])

function rowForPo(record: SavedQuoteRecord): (string | number)[] {
  const p = mergeScmPoGapsFromOvfAndQuote(record, record.scmPo!)
  const ovf = record.ovf
  const loc = getCompanyLocationById(p.companyLocationId)
  const linesJoined = lineItemsExportSummary(record, p)

  const locCell = loc ? `${loc.label}\n${loc.address}` : p.companyLocationId

  return [
    record.id,
    p.poRef,
    p.status,
    toDisplayDateTime(p.updatedAt),
    p.vendorNameSnapshot,
    p.vendorAddressSnapshot,
    p.sourceOfSupply,
    p.destinationOfSupply,
    locCell,
    toYyyyMmDd(p.purchaseDate),
    toYyyyMmDd(p.deliveryDate),
    parseNumericCell(p.paymentTermsDays),
    p.ovfNumber,
    p.quoteNumber,
    p.companyPoNumber,
    p.customerPoNumber,
    toYyyyMmDd(p.customerPoDate),
    p.ovfApprover,
    p.customerName,
    linesJoined,
    parseNumericCell(ovf?.fields.margin as string | undefined),
    parseNumericCell(ovf?.fields.marginPercent as string | undefined),
    (ovf?.fields.vendorName ?? '') as string,
    (ovf?.fields.billingState ?? '') as string,
    ovf?.fields.shippingAddress
      ? String(ovf.fields.shippingAddress).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : '',
  ]
}

const LINE_HEADERS = [
  'PO ref',
  'Quote record id',
  'Line',
  'Item details',
  'Part number',
  'HSN code',
  'PO type',
  'Qty',
  'Rate (INR)',
  'Tax %',
  'Amount total (INR)',
] as const

function buildPoLineDataRows(withPo: SavedQuoteRecord[]): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const r of withPo) {
    const p = mergeScmPoGapsFromOvfAndQuote(r, r.scmPo!)
    p.lines.forEach((raw, i) => {
      const line = normalizeScmPoLine(raw)
      const total = computeLineTotalInr(line.quantity, line.rate, line.tax)
      rows.push([
        p.poRef,
        r.id,
        i + 1,
        String(line.itemDetails).replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        line.partNumber,
        line.hsnCode,
        line.poType,
        parseNumericCell(line.quantity),
        parseNumericCell(line.rate),
        parseNumericCell(line.tax),
        total,
      ])
    })
  }
  return rows
}

const OVF_HEADERS = [
  'Quote record id',
  'Quote ref',
  'OVF ref',
  'Customer',
  'Workflow',
  'Finance approved by',
  'OVF product summary',
  'Vendor name (OVF)',
  'Margin',
  'Margin %',
  'Has SCM PO',
] as const

function buildOvfRows(approved: SavedQuoteRecord[]) {
  return approved.map((r) => {
    const o = r.ovf!
    const data = normalizeQuoteFormData(r.formSnapshot as QuoteFormData)
    return [
      r.id,
      r.quoteRef || data.quoteRef,
      o.ovfRef,
      o.fields.customerName || data.customerName,
      o.workflowStatus ?? '',
      o.financeApprovedBy ?? '',
      o.fields.productName,
      o.fields.vendorName,
      parseNumericCell(o.fields.margin as string | undefined),
      parseNumericCell(o.fields.marginPercent as string | undefined),
      r.scmPo ? 'yes' : 'no',
    ] as (string | number)[]
  })
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, colCount: number) {
  const h = sheet.getRow(1)
  h.height = 24
  h.font = { bold: true, size: 11, color: { argb: 'FF1E293B' } }
  h.alignment = {
    vertical: 'middle',
    horizontal: 'center',
    wrapText: true,
  }
  h.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }
  h.border = {
    bottom: { style: 'medium', color: { argb: 'FF94A3B8' } },
  }
  for (let c = 1; c <= colCount; c++) {
    const cell = h.getCell(c)
    cell.border = {
      ...cell.border,
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  }
}

function setBodyAlignment(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  endRow: number,
  colWrap0: Set<number>,
  colNumRight0: Set<number>,
) {
  for (let r = startRow; r <= endRow; r++) {
    const row = sheet.getRow(r)
    let maxLines = 1
    row.eachCell((cell, col) => {
      const col0 = col - 1
      const wrap = colWrap0.has(col0)
      const isNum = colNumRight0.has(col0)
      cell.alignment = {
        vertical: 'top',
        horizontal: isNum ? 'right' : 'left',
        wrapText: wrap,
        indent: 0,
      }
      const t = cellString(cell.value)
      if (t) maxLines = Math.max(maxLines, t.split(/\n/).length)
    })
    row.height = maxLines > 1 ? Math.min(MAX_ROW_HEIGHT, 16 * maxLines) : 17
  }
}

function applyColumnWidths(sheet: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w
  })
}

function freezeTopRow(sheet: ExcelJS.Worksheet) {
  sheet.views = [
    {
      state: 'frozen',
      ySplit: 1,
      xSplit: 0,
      topLeftCell: 'A2',
      activeCell: 'A2',
      showGridLines: true,
    } as ExcelJS.WorksheetView,
  ]
}

function addSheetFromTable(
  book: ExcelJS.Workbook,
  name: string,
  tableName: string,
  displayName: string,
  headerRow: readonly (string | number)[],
  dataRows: (string | number)[][],
  colWrap0: Set<number>,
  colNum0: Set<number>,
) {
  const sh = book.addWorksheet(name, {
    properties: { defaultRowHeight: 18, defaultColWidth: MIN_COL_WIDTH },
  })

  const headers = [...headerRow] as (string | number)[]

  if (dataRows.length === 0) {
    sh.addRow(headers)
  } else {
    sh.addTable({
      name: tableName,
      displayName,
      ref: 'A1',
      headerRow: true,
      style: { theme: 'TableStyleMedium9', showRowStripes: true },
      columns: headers.map((h) => ({ name: String(h), filterButton: true })),
      rows: dataRows,
    })
  }

  const colCount = headers.length
  styleHeaderRow(sh, colCount)
  applyColumnWidths(sh, buildColumnWidths(headers, dataRows))
  freezeTopRow(sh)

  const dataEnd = 1 + dataRows.length
  for (let r = 2; r <= dataEnd; r++) {
    const row = sh.getRow(r)
    for (const c0 of colNum0) {
      if (c0 < 0 || c0 >= colCount) continue
      const cell = row.getCell(c0 + 1)
      if (cell.value === '' || cell.value == null) continue
      if (typeof cell.value === 'string') continue
      if (typeof cell.value !== 'number' || Number.isNaN(cell.value)) continue

      if (name === 'SCM POs') {
        if (c0 === 11) cell.numFmt = '0' // days
        else if (c0 === 20) cell.numFmt = '#,##0.00'
        else if (c0 === 21) cell.numFmt = '0.00' // margin %
        continue
      }
      if (name === 'PO line items') {
        if (c0 === 2) cell.numFmt = '0'
        else if (c0 === 6) cell.numFmt = '#,##0.##'
        else if (c0 === 7) cell.numFmt = '#,##0.00'
        else if (c0 === 8) cell.numFmt = '0.00' // tax %
        else if (c0 === 9) cell.numFmt = '#,##0.00' // amount
        continue
      }
      if (name === 'OVF index') {
        if (c0 === 8) cell.numFmt = '#,##0.00'
        else if (c0 === 9) cell.numFmt = '0.00'
      }
    }
  }

  if (dataRows.length > 0) {
    setBodyAlignment(sh, 2, dataEnd, colWrap0, colNum0)
  } else {
    sh.getRow(1).height = 24
  }
}

/** Export all SCM PO rows with linked OVF snapshot columns. Download runs only when you call this (e.g. from the export modal). */
export async function exportScmPoWorkbookToFile(
  options?: ScmExportOptions,
): Promise<void> {
  const withPo = listSavedQuotesWithScmPo()
  const approved = listOvfFinanceApprovedForScm()

  const book = new ExcelJS.Workbook()
  book.creator = 'SCM Workflow'
  book.created = new Date()
  book.modified = new Date()

  const poDataRows = withPo.map((r) => rowForPo(r))
  const lineDataRows = buildPoLineDataRows(withPo)
  const ovfDataRows = buildOvfRows(approved)
  const fileName = localExportFilename()

  addExportCoverSheet(book, {
    reportTitle: options?.reportTitle,
    notes: options?.notes,
    preparedBy: options?.preparedBy,
    poCount: withPo.length,
    lineRowCount: lineDataRows.length,
    ovfIndexCount: ovfDataRows.length,
    fileName,
  })

  addSheetFromTable(
    book,
    'SCM POs',
    'tblScmPos',
    'ScmPos',
    PO_HEADERS,
    poDataRows,
    PO_COL_WRAP0,
    PO_COL_NUM0,
  )
  addSheetFromTable(
    book,
    'PO line items',
    'tblPoLines',
    'PoLineItems',
    LINE_HEADERS,
    lineDataRows,
    LINE_COL_WRAP0,
    LINE_COL_NUM0,
  )
  addSheetFromTable(
    book,
    'OVF index',
    'tblOvfIdx',
    'OvfIndex',
    OVF_HEADERS,
    ovfDataRows,
    OVF_COL_WRAP0,
    OVF_COL_NUM0,
  )

  const buffer = (await book.xlsx.writeBuffer()) as ArrayBuffer
  triggerDownload(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    fileName,
  )
}
