import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import { filterCommercialLines } from './quoteLineItems'
import { getSenderPdfContent } from './senderAddresses'
import type { SenderPdfContent } from './senderAddresses'

function parseQty(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function lineAmount(line: QuoteLineForm): number {
  return parseQty(line.qty) * parseMoney(line.unitPrice)
}

/** Single “To,” name line (honorifics can be typed into the name field). */
export function recipientDisplayLine(
  customerName: string | undefined | null,
): string {
  return String(customerName ?? '').trim()
}

/** Letter-style “To,” block: recipient, optional company name, then address lines. */
export function recipientBlockLines(
  customerName: string | undefined | null,
  customerCompanyName: string | undefined | null,
  customerAddress: string | undefined | null,
): string[] {
  const lines: string[] = ['To,']
  const display = recipientDisplayLine(customerName)
  if (display) lines.push(display)
  const company = String(customerCompanyName ?? '').trim()
  if (company) lines.push(company)
  const trimmedAddr = String(customerAddress ?? '').trim()
  if (trimmedAddr) {
    for (const part of trimmedAddr.split(/\r?\n/)) {
      const row = part.trim()
      if (row) lines.push(row)
    }
  }
  if (lines.length === 1) lines.push('—')
  return lines
}

export function getQuoteMoneySummary(data: QuoteFormData) {
  const rows = filterCommercialLines(data.lineItems)
  const total = rows.reduce((sum, line) => sum + lineAmount(line), 0)
  return { total }
}

/** CACHE letterhead mark — prefer `public/cache1.png`, else `cache-logo.png`. */
async function loadQuoteLogoDataUrl(): Promise<string | null> {
  const base = import.meta.env.BASE_URL
  for (const name of ['cache1.png', 'cache-logo.png'] as const) {
    try {
      const res = await fetch(`${base}${name}`)
      if (!res.ok) continue
      const blob = await res.blob()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('logo read failed'))
        reader.readAsDataURL(blob)
      })
      return dataUrl
    } catch {
      /* try next */
    }
  }
  return null
}

/** Women Owned mark (`public/women-owned-logo.png`). */
async function loadWomenOwnedLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}women-owned-logo.png`)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('women-owned logo read failed'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

function getImageNaturalSizeFromDataUrl(
  dataUrl: string,
): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => reject(new Error('logo decode failed'))
    img.src = dataUrl
  })
}

function logoSizeMm(
  naturalW: number,
  naturalH: number,
  maxWmm: number,
  maxHmm: number,
): { w: number; h: number } {
  if (naturalW <= 0 || naturalH <= 0) {
    return { w: maxWmm, h: maxHmm }
  }
  const aspect = naturalW / naturalH
  let w = maxWmm
  let h = w / aspect
  if (h > maxHmm) {
    h = maxHmm
    w = h * aspect
  }
  return { w, h }
}

type LogoBox = { url: string; w: number; h: number } | null

async function resolveLogoBox(
  dataUrl: string | null,
  maxWmm: number,
  maxHmm: number,
): Promise<LogoBox> {
  if (!dataUrl) return null
  try {
    const { w: nw, h: nh } = await getImageNaturalSizeFromDataUrl(dataUrl)
    const { w, h } = logoSizeMm(nw, nh, maxWmm, maxHmm)
    return { url: dataUrl, w, h }
  } catch {
    return null
  }
}

type PdfLike = {
  internal: { pageSize: { getWidth: () => number; getHeight: () => number } }
  getNumberOfPages: () => number
  setPage: (n: number) => void
  setLineWidth: (w: number) => void
  addPage: () => void
  setFillColor: (r: number, g: number, b: number) => void
  rect: (
    x: number,
    y: number,
    w: number,
    h: number,
    mode?: string,
  ) => void
  addImage: (
    imageData: string | Uint8Array | HTMLImageElement | HTMLCanvasElement,
    format: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: string,
    compression?: string,
  ) => void
  setFont: (face: string, style: string) => void
  setFontSize: (size: number) => void
  setTextColor: (r: number, g: number, b: number) => void
  setDrawColor: (r: number, g: number, b: number) => void
  line: (x1: number, y1: number, x2: number, y2: number) => void
  text: (
    text: string | string[],
    x: number,
    y: number,
    options?: { align?: 'center' | 'right' },
  ) => void
  splitTextToSize: (text: string, maxWidth: number) => string[]
  roundedRect: (
    x: number,
    y: number,
    w: number,
    h: number,
    rx: number,
    ry: number,
    style?: string,
  ) => void
}

function drawLetterheadBand(
  doc: PdfLike,
  W: number,
  M: number,
  headerBandMm: number,
  cacheLogo: LogoBox,
  womenOwned: LogoBox,
) {
  doc.setFillColor(255, 255, 255)
  doc.rect(0, 0, W, headerBandMm, 'F')
  if (cacheLogo) {
    const logoY = (headerBandMm - cacheLogo.h) / 2
    try {
      doc.addImage(
        cacheLogo.url,
        'PNG',
        M,
        logoY,
        cacheLogo.w,
        cacheLogo.h,
        undefined,
        'SLOW',
      )
    } catch {
      /* skip */
    }
  }
  if (womenOwned) {
    const xRight = W - M - womenOwned.w
    const yRight = (headerBandMm - womenOwned.h) / 2
    try {
      doc.addImage(
        womenOwned.url,
        'PNG',
        xRight,
        yRight,
        womenOwned.w,
        womenOwned.h,
        undefined,
        'SLOW',
      )
    } catch {
      /* skip */
    }
  }
}

/** Mm from company baseline through last contact line (matches draw steps). */
function measureFooterBelowCompanyMm(
  doc: PdfLike,
  W: number,
  M: number,
  sender: SenderPdfContent,
): number {
  const regWrap = doc.splitTextToSize(sender.footerRegisteredLine, W - 2 * M - 18)
  const cWrap = doc.splitTextToSize(sender.footerContactLine, W - 2 * M - 14)
  return (
    3.2 +
    4 +
    regWrap.length * 3.3 +
    0.3 +
    cWrap.length * 3.1
  )
}

const FOOTER_PAGE_LABEL_STRIP_MM = 6.5
const FOOTER_BOTTOM_PAD_MM = 2.5
/** ~9pt single line + buffer above baseline so the stripe height matches every page. */
const FOOTER_COMPANY_BAND_MM = 5.2

/**
 * Fixed bottom margin for all pages: company block + page label strip + pad.
 * Measured from sender text wraps so layout matches what we draw.
 */
function measureFooterReserveMm(
  doc: PdfLike,
  W: number,
  M: number,
  sender: SenderPdfContent,
): number {
  const below = measureFooterBelowCompanyMm(doc, W, M, sender)
  const used =
    FOOTER_COMPANY_BAND_MM +
    below +
    FOOTER_PAGE_LABEL_STRIP_MM +
    FOOTER_BOTTOM_PAD_MM +
    1
  return Math.max(38, Math.ceil(used))
}

function drawCompanyFooterBlock(
  doc: PdfLike,
  W: number,
  M: number,
  sender: SenderPdfContent,
  footerReserveMm: number,
) {
  const H = doc.internal.pageSize.getHeight()
  const belowCompany = measureFooterBelowCompanyMm(doc, W, M, sender)
  const companyBaseline =
    H -
    FOOTER_PAGE_LABEL_STRIP_MM -
    FOOTER_BOTTOM_PAD_MM -
    belowCompany
  const stripeTop = H - footerReserveMm
  const minCompanyBaseline = stripeTop + FOOTER_COMPANY_BAND_MM
  let y = Math.max(companyBaseline, minCompanyBaseline)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 23, 42)
  doc.text(sender.footerCompany, W / 2, y, { align: 'center' })
  y += 3.2
  doc.setDrawColor(30, 41, 59)
  doc.setLineWidth(0.25)
  doc.line(M + 26, y, W - M - 26, y)
  y += 4
  doc.setFontSize(7.8)
  const regWrap = doc.splitTextToSize(sender.footerRegisteredLine, W - 2 * M - 18)
  doc.setFont('helvetica', 'bold')
  regWrap.forEach((ln) => {
    doc.text(ln, W / 2, y, { align: 'center' })
    y += 3.3
  })
  y += 0.3
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.2)
  doc.setTextColor(55, 65, 81)
  const cWrap = doc.splitTextToSize(sender.footerContactLine, W - 2 * M - 14)
  cWrap.forEach((ln) => {
    doc.text(ln, W / 2, y, { align: 'center' })
    y += 3.1
  })
}

function drawFootersAndPageLabels(
  doc: PdfLike,
  W: number,
  M: number,
  sender: SenderPdfContent,
  footerReserveMm: number,
) {
  const n = doc.getNumberOfPages()
  const H = doc.internal.pageSize.getHeight()
  for (let p = 1; p <= n; p++) {
    doc.setPage(p)
    drawCompanyFooterBlock(doc, W, M, sender, footerReserveMm)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(148, 163, 184)
    doc.text(
      `Page ${p} of ${n}`,
      M,
      H - FOOTER_BOTTOM_PAD_MM,
    )
  }
}
/** Min height to reserve before starting the commercials table on a page. */
const COMMERCIALS_MIN_START_MM = 52
/** Commercials table column widths (mm); must sum to content width W − 2M. */
const COL_SNO = 10
const COL_PROD = 42
const COL_DESC = 60
const COL_QTY = 14
const COL_UNIT = 28
const COL_TOT = 28
const COMM_TABLE_HDR_H = 9.5
const COMM_CELL_LH = 4.05
/** Space from “TERMS AND CONDITIONS:” baseline to body text (font + gap). */
const TERMS_TITLE_BODY_GAP_MM = 9
const TERMS_LINE_STEP_MM = 4.65
const TERMS_PARA_GAP_MM = 2.5
/** Extra inset for T&C + closing so the block sits slightly right of the main margin. */
const TERMS_EXTRA_LEFT_MM = 5
/**
 * If vertical space from the cursor to the footer is at least this fraction of
 * (footer zone − top margin), T&C starts on the same page; otherwise a new page is opened.
 */
const TERMS_SAME_PAGE_MIN_REMAINING_FRACTION = 0.5
/** Hang continuation lines under the number (e.g. address under “6.”). */
const TERMS_NUMBERED_HANG_INDENT_MM = 6

/** Line starts a numbered list item (e.g. "1.", "6. The order..."). */
export function isNumberedTermLine(line: string): boolean {
  return /^\d+\./.test(line.trim())
}

/** First line is “N.” and further lines belong under that number (hanging indent). */
export function isNumberedBlockWithContinuations(lines: string[]): boolean {
  return lines.length > 1 && isNumberedTermLine(lines[0])
}

/**
 * Group a numbered line with following lines that do not start a new number
 * (e.g. item "6." + address lines), so they paginate as one unit.
 */
export function buildTermSegments(
  lines: string[],
): Array<{ kind: 'gap' } | { kind: 'block'; lines: string[] }> {
  const out: Array<{ kind: 'gap' } | { kind: 'block'; lines: string[] }> = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) {
      out.push({ kind: 'gap' })
      i++
      continue
    }
    if (isNumberedTermLine(lines[i])) {
      const block: string[] = [lines[i]]
      let j = i + 1
      while (j < lines.length) {
        const t = lines[j].trim()
        if (!t) break
        if (isNumberedTermLine(lines[j])) break
        block.push(lines[j])
        j++
      }
      out.push({ kind: 'block', lines: block })
      i = j
    } else {
      out.push({ kind: 'block', lines: [lines[i]] })
      i++
    }
  }
  return out
}

/** Single flowing PDF: header/recipient/terms blocks, then line items + totals + T&C as space allows. */
export async function buildQuoteTwoPagePdf(
  raw: QuoteFormData & { customerTitle?: string },
): Promise<Blob> {
  const data = normalizeQuoteFormData(raw)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as unknown as PdfLike & {
    output: (type: 'blob') => Blob
  }
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 14
  const headerBandMm = 32
  /** Same bounding box for Cache + Women Owned so both scale consistently in the band. */
  const HEADER_LOGO_MAX_W_MM = 38
  const HEADER_LOGO_MAX_H_MM = headerBandMm - 5
  const { total } = getQuoteMoneySummary(data)
  const rows = filterCommercialLines(data.lineItems)

  const [logoDataUrl, womenOwnedDataUrl] = await Promise.all([
    loadQuoteLogoDataUrl(),
    loadWomenOwnedLogoDataUrl(),
  ])

  const [cacheLogoBox, womenOwnedBox] = await Promise.all([
    resolveLogoBox(logoDataUrl, HEADER_LOGO_MAX_W_MM, HEADER_LOGO_MAX_H_MM),
    resolveLogoBox(womenOwnedDataUrl, HEADER_LOGO_MAX_W_MM, HEADER_LOGO_MAX_H_MM),
  ])

  doc.setFillColor(255, 255, 255)
  doc.rect(0, 0, W, H, 'F')

  drawLetterheadBand(doc, W, M, headerBandMm, cacheLogoBox, womenOwnedBox)

  const senderPdf = getSenderPdfContent(
    data.senderAddressPreset,
    data.quoteDate,
    data.quoteRef,
    data.validUntil,
  )
  const footerReserveMm = measureFooterReserveMm(doc, W, M, senderPdf)
  const contentTop = headerBandMm + 3
  const xAlignRight = W - M

  let senderY = contentTop
  doc.setFontSize(9)
  for (const line of senderPdf.headerLines) {
    if (line.blue) doc.setTextColor(0, 82, 191)
    else doc.setTextColor(15, 23, 42)
    doc.setFont('helvetica', line.bold === false ? 'normal' : 'bold')
    doc.text(line.text, xAlignRight, senderY, { align: 'right' })
    senderY += 4.25
  }

  const recipientStartY = senderY + 5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(15, 23, 42)
  const maxRecipientW = W - M - 24
  let yRecipient = recipientStartY
  for (const rawLine of recipientBlockLines(
    data.customerName,
    data.customerCompanyName,
    data.customerAddress,
  )) {
    const wrapped = doc.splitTextToSize(rawLine, maxRecipientW)
    for (const pl of wrapped) {
      doc.text(pl, M, yRecipient)
      yRecipient += 4.65
    }
  }

  let y = yRecipient + 6
  const bottomLimit = () => H - footerReserveMm
  const TW = W - 2 * M

  const bumpPage = () => {
    doc.addPage()
    doc.setFillColor(255, 255, 255)
    doc.rect(0, 0, W, H, 'F')
    y = M + 10
  }

  const needSpace = (mm: number) => {
    if (y + mm <= bottomLimit()) return
    bumpPage()
  }

  // ----- Letter block: Sub, salutation, intro -----
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(15, 23, 42)
  const subLines = doc.splitTextToSize(
    `Sub: ${data.subject.trim() || '—'}`,
    TW,
  )
  for (const ln of subLines) {
    needSpace(5.5)
    doc.text(ln, M, y)
    y += 5.1
  }
  y += 3

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(15, 23, 42)
  needSpace(7)
  doc.text(data.quoteSalutation.trim() || 'Dear Sir,', M, y)
  y += 7

  doc.setTextColor(51, 65, 85)
  const introJoined = (data.quoteIntro || '').trim() || '—'
  for (const para of introJoined.split(/\n\s*\n/)) {
    const t = para.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const wrapped = doc.splitTextToSize(t, TW)
    for (const w of wrapped) {
      needSpace(5)
      doc.text(w, M, y)
      y += 4.65
    }
    y += 2
  }
  y += 4

  // ----- Bordered commercials table (S.No., Product, Description, Qty, prices) -----
  if (y + COMMERCIALS_MIN_START_MM > bottomLimit()) bumpPage()

  const X0 = M
  const xProd = X0 + COL_SNO
  const xDesc = xProd + COL_PROD
  const xQty = xDesc + COL_DESC
  const xUnit = xQty + COL_QTY
  const xTot = xUnit + COL_UNIT
  const xR = W - M
  const pad = 1.5
  const wProd = COL_PROD - pad * 2
  const wDesc = COL_DESC - pad * 2
  const rowPad = 2.8

  const sealTable = (ts: number, yEnd: number) => {
    doc.setDrawColor(15, 23, 42)
    doc.setLineWidth(0.25)
    doc.rect(X0, ts, TW, yEnd - ts, 'S')
    for (const xv of [xProd, xDesc, xQty, xUnit, xTot, xR]) {
      doc.line(xv, ts, xv, yEnd)
    }
  }

  const drawCommercialHeader = (top: number) => {
    doc.setDrawColor(15, 23, 42)
    doc.setLineWidth(0.25)
    doc.setFillColor(248, 250, 252)
    doc.rect(X0, top, TW, COMM_TABLE_HDR_H, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.2)
    doc.setTextColor(30, 41, 59)
    const hy = top + 5.3
    doc.text('S.No.', X0 + pad, hy)
    doc.text('Product', xProd + pad, hy)
    doc.text('Description', xDesc + pad, hy)
    doc.text('Qty', xQty + pad, hy)
    let uy = top + 3.4
    for (const ln of doc.splitTextToSize('Unit Price (INR)', COL_UNIT - 1.5)) {
      doc.text(ln, xUnit + 0.5, uy)
      uy += 3.1
    }
    let ty = top + 3.4
    for (const ln of doc.splitTextToSize('Total Price (INR)', COL_TOT - 1.5)) {
      doc.text(ln, xTot + 0.5, ty)
      ty += 3.1
    }
    for (const xv of [xProd, xDesc, xQty, xUnit, xTot, xR]) {
      doc.line(xv, top, xv, top + COMM_TABLE_HDR_H)
    }
    doc.line(X0, top, xR, top)
    doc.line(X0, top + COMM_TABLE_HDR_H, xR, top + COMM_TABLE_HDR_H)
  }

  let tableStartY = y
  drawCommercialHeader(tableStartY)
  let rowY = tableStartY + COMM_TABLE_HDR_H
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(15, 23, 42)

  let idx = 0
  while (idx < rows.length) {
    const line = rows[idx]
    const amt = lineAmount(line)
    const prodT = (line.product || '').trim() || '—'
    const descT = (line.description || '').trim() || '—'
    const pLines = doc.splitTextToSize(prodT, wProd)
    const dLines = doc.splitTextToSize(descT, wDesc)
    const nl = Math.max(pLines.length, dLines.length, 1)
    const rowH = Math.max(8, nl * COMM_CELL_LH + rowPad)

    if (rowY + rowH > bottomLimit()) {
      sealTable(tableStartY, rowY)
      bumpPage()
      tableStartY = y
      drawCommercialHeader(tableStartY)
      rowY = tableStartY + COMM_TABLE_HDR_H
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      doc.setTextColor(15, 23, 42)
      continue
    }

    doc.setDrawColor(15, 23, 42)
    doc.setLineWidth(0.25)
    doc.line(X0, rowY, xR, rowY)
    const cy = rowY + 5
    doc.text(String(idx + 1), X0 + pad, cy)
    pLines.forEach((ln, i) => {
      doc.text(ln, xProd + pad, cy + i * COMM_CELL_LH)
    })
    dLines.forEach((ln, i) => {
      doc.text(ln, xDesc + pad, cy + i * COMM_CELL_LH)
    })
    doc.text(String(parseQty(line.qty)), xQty + pad, cy)
    doc.text(
      formatMoney(parseMoney(line.unitPrice)),
      xUnit + COL_UNIT - pad,
      cy,
      { align: 'right' },
    )
    doc.text(formatMoney(amt), xTot + COL_TOT - pad, cy, { align: 'right' })
    rowY += rowH
    doc.line(X0, rowY, xR, rowY)
    idx++
  }

  const drawFooterRow = (label: string, amount: string, bold: boolean) => {
    const fh = 7.5
    if (rowY + fh > bottomLimit()) {
      sealTable(tableStartY, rowY)
      bumpPage()
      tableStartY = y
      drawCommercialHeader(tableStartY)
      rowY = tableStartY + COMM_TABLE_HDR_H
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
    }
    doc.setDrawColor(15, 23, 42)
    doc.line(X0, rowY, xR, rowY)
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(15, 23, 42)
    doc.text(label, xTot - 2, rowY + 5.2, { align: 'right' })
    doc.text(amount, xR - pad, rowY + 5.2, { align: 'right' })
    rowY += fh
    doc.line(X0, rowY, xR, rowY)
  }

  drawFooterRow('Grand Total', formatMoney(total), true)

  sealTable(tableStartY, rowY)
  y = rowY + 10

  // ----- Closing -----
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(51, 65, 85)
  const closingRaw = (data.quoteClosing || '').trim() || '—'
  for (const para of closingRaw.split(/\n\s*\n/)) {
    const t = para.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const wrapped = doc.splitTextToSize(t, TW)
    for (const w of wrapped) {
      needSpace(5)
      doc.text(w, M, y)
      y += 4.65
    }
    y += 2
  }
  y += 4

  // ----- Terms: same page only if enough room left (“half page” of body); else new page -----
  const bodyBottomY = H - footerReserveMm
  const usableBodySpan = bodyBottomY - M
  const minRemainForTermsHere =
    usableBodySpan * TERMS_SAME_PAGE_MIN_REMAINING_FRACTION
  const spaceBelowClosing = bodyBottomY - y

  let yTerms: number
  if (spaceBelowClosing >= minRemainForTermsHere) {
    yTerms = y + 12
  } else {
    doc.addPage()
    doc.setFillColor(255, 255, 255)
    doc.rect(0, 0, W, H, 'F')
    drawLetterheadBand(doc, W, M, headerBandMm, cacheLogoBox, womenOwnedBox)
    yTerms = headerBandMm + 8
  }

  const xTerms = M + TERMS_EXTRA_LEFT_MM
  const termsWrapW = W - 2 * M - TERMS_EXTRA_LEFT_MM

  const rawTerms = (data.termsAndConditions || '').trim() || '—'
  const termLines = rawTerms.split(/\r?\n/)
  const termSegments = buildTermSegments(termLines)

  const estimateBlockHeightMm = (blockLines: string[]): number => {
    if (blockLines.length === 0) return TERMS_LINE_STEP_MM
    const hang = isNumberedBlockWithContinuations(blockLines)
    const hangMm = hang ? TERMS_NUMBERED_HANG_INDENT_MM : 0
    let h = 0
    for (let k = 0; k < blockLines.length; k++) {
      const w =
        termsWrapW - (hang && k > 0 ? hangMm : 0)
      const wrapped = doc.splitTextToSize(blockLines[k].trim(), w)
      h += wrapped.length * TERMS_LINE_STEP_MM
      if (k < blockLines.length - 1) h += TERMS_PARA_GAP_MM
    }
    return h
  }

  const ensureTermsSpace = (needMm: number) => {
    if (yTerms + needMm <= H - footerReserveMm) return
    doc.addPage()
    doc.setFillColor(255, 255, 255)
    doc.rect(0, 0, W, H, 'F')
    drawLetterheadBand(doc, W, M, headerBandMm, cacheLogoBox, womenOwnedBox)
    yTerms = headerBandMm + 8
  }

  const firstBlockSeg = termSegments.find((s) => s.kind === 'block') as
    | { kind: 'block'; lines: string[] }
    | undefined
  const firstBodyH = firstBlockSeg
    ? estimateBlockHeightMm(firstBlockSeg.lines)
    : TERMS_LINE_STEP_MM
  let leadingGapMm = 0
  for (const s of termSegments) {
    if (s.kind === 'block') break
    if (s.kind === 'gap') leadingGapMm += 2
  }
  ensureTermsSpace(TERMS_TITLE_BODY_GAP_MM + leadingGapMm + firstBodyH + 1)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(15, 23, 42)
  doc.text('TERMS AND CONDITIONS:', xTerms, yTerms)
  yTerms += TERMS_TITLE_BODY_GAP_MM
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(51, 65, 85)

  for (const seg of termSegments) {
    if (seg.kind === 'gap') {
      yTerms += 2
      continue
    }
    const need = estimateBlockHeightMm(seg.lines) + 1
    ensureTermsSpace(need)
    const hang = isNumberedBlockWithContinuations(seg.lines)
    const hangMm = hang ? TERMS_NUMBERED_HANG_INDENT_MM : 0
    for (let pi = 0; pi < seg.lines.length; pi++) {
      const para = seg.lines[pi]
      const trimmed = para.trim()
      if (!trimmed) continue
      const cont = hang && pi > 0
      const xLine = xTerms + (cont ? hangMm : 0)
      const wLine = termsWrapW - (cont ? hangMm : 0)
      const wrapped = doc.splitTextToSize(trimmed, wLine)
      for (const wline of wrapped) {
        doc.text(wline, xLine, yTerms)
        yTerms += TERMS_LINE_STEP_MM
      }
      if (pi < seg.lines.length - 1) yTerms += TERMS_PARA_GAP_MM
    }
    yTerms += TERMS_PARA_GAP_MM
  }

  yTerms += 5
  ensureTermsSpace(22)
  doc.setTextColor(15, 23, 42)
  doc.text('Thank you,', xTerms, yTerms)
  yTerms += 6
  const sig = data.signatoryName.trim()
  if (sig) {
    doc.text(sig, xTerms, yTerms)
  }

  drawFootersAndPageLabels(doc, W, M, senderPdf, footerReserveMm)

  return doc.output('blob')
}
