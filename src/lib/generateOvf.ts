import type { OvfFormFields } from '../types/ovf'
import {
  extraChargeInrFromField,
  formatChargeFieldForMeta,
} from './ovfExtraCharges'
import {
  computeOvfAggregateEconomics,
  hasAnyVendorPurchase,
  normalizeVendorPurchaseMap,
  getOvfMarginDisplayStrings,
} from './ovfVendorEconomics'
import { filterCommercialLines } from './quoteLineItems'
import { getQuoteMoneySummary, lineAmount } from './quotePdfTemplate'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import { effectiveOvfCountry } from './ovfFormDefaults'
import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import { getSenderOvfSplit } from './senderAddresses'

/** 25 placeholder sections — labels A–Y (future: map UI buttons to blocks). */
export const OVF_BLOCK_IDS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
] as const

export type OvfBlockId = (typeof OVF_BLOCK_IDS)[number]

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function nl2br(s: string): string {
  return esc(s).replaceAll('\n', '<br/>')
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** GST % for line totals (amounts assumed exclusive of GST). */
export function parseGstPercent(raw: string | undefined): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n) || n < 0) return 18
  return n
}

/**
 * Customer charges HTML: quote line sell (Unit / Line total), vendor line (same
 * column titles), margin, margin %, then GST breakdown.
 */
export function buildOvfCustomerChargesTableHtml(
  lines: QuoteLineForm[],
  gstPercent: number,
  vendorByLine: Record<string, string> = {},
  /** Freight/finance (INR) added to the vendor purchase footer total only. */
  vendorFooterExtras?: { freightInr: number; financeInr: number },
): string {
  if (lines.length === 0) {
    return `<p class="ovf-line-items-empty">${esc('—')}</p>`
  }
  const agg = computeOvfAggregateEconomics(lines, vendorByLine)
  const vendorExtrasSum =
    vendorFooterExtras != null
      ? vendorFooterExtras.freightInr + vendorFooterExtras.financeInr
      : 0
  const showVendorTotals =
    hasAnyVendorPurchase(lines, vendorByLine) || vendorExtrasSum > 0

  let sumBase = 0
  let sumGst = 0
  let sumWith = 0
  const rows = lines
    .map((ln, i) => {
      const product = (ln.product || '').trim() || '—'
      const desc = ln.description.trim()
      const productInner = desc
        ? `${esc(product)} <span class="ovf-line-items-desc">— ${esc(desc)}</span>`
        : esc(product)
      const base = lineAmount(ln)
      const gst = base * (gstPercent / 100)
      const withGst = base + gst
      sumBase += base
      sumGst += gst
      sumWith += withGst
      const eco = agg.lineRows[i]
      const pu =
        eco.purchaseTotal != null ? formatInr(eco.purchaseTotal) : esc('—')
      const marg =
        eco.marginInr != null ? formatInr(eco.marginInr) : esc('—')
      const mp =
        eco.marginPctOnSale != null
          ? `${eco.marginPctOnSale.toFixed(2)}%`
          : esc('—')
      const vu = eco.vendorUnitDisplay ? esc(eco.vendorUnitDisplay) : esc('—')
      return `<tr>
<td>${productInner}</td>
<td class="ovf-num">${esc(String(ln.qty))}</td>
<td class="ovf-num">${esc(String(ln.unitPrice))}</td>
<td class="ovf-num">${esc(formatInr(base))}</td>
<td class="ovf-num">${vu}</td>
<td class="ovf-num">${pu}</td>
<td class="ovf-num">${marg}</td>
<td class="ovf-num">${mp}</td>
<td class="ovf-num">${esc(formatInr(gst))}</td>
<td class="ovf-num">${esc(formatInr(withGst))}</td>
</tr>`
    })
    .join('\n')

  const vendorFootPurchaseTotal =
    agg.totalPurchase + (vendorFooterExtras?.freightInr ?? 0) + (vendorFooterExtras?.financeInr ?? 0)
  const footMarginInr = sumBase - vendorFootPurchaseTotal
  const footMarginPct = sumBase > 0 ? (footMarginInr / sumBase) * 100 : null

  const footPurch = showVendorTotals
    ? `<td class="ovf-num"><strong>${esc(formatInr(vendorFootPurchaseTotal))}</strong></td>
<td class="ovf-num"><strong>${esc(formatInr(footMarginInr))}</strong></td>
<td class="ovf-num"><strong>${
        footMarginPct != null
          ? esc(`${footMarginPct.toFixed(2)}%`)
          : esc('—')
      }</strong></td>`
    : `<td class="ovf-num">${esc('—')}</td>
<td class="ovf-num">${esc('—')}</td>
<td class="ovf-num">${esc('—')}</td>`

  const foot = `<tr class="ovf-line-items-totals">
<td colspan="3"><strong>${esc('Total')}</strong></td>
<td class="ovf-num"><strong>${esc(formatInr(sumBase))}</strong></td>
<td class="ovf-num">${esc('—')}</td>
${footPurch}
<td class="ovf-num"><strong>${esc(formatInr(sumGst))}</strong></td>
<td class="ovf-num"><strong>${esc(formatInr(sumWith))}</strong></td>
</tr>`
  return `<table class="ovf-line-items-table">
<thead><tr>
<th>Product name</th>
<th>Qty</th>
<th>Unit (INR)</th>
<th>Total (INR)</th>
<th>Unit (INR)</th>
<th>Total (INR)</th>
<th>Margin (INR)</th>
<th>Margin %</th>
<th>Total amount GST</th>
<th>Total amount with GST</th>
</tr></thead>
<tbody>${rows}${foot}</tbody>
</table>
<p class="ovf-gst-note">GST applied at ${esc(String(gstPercent))}% on total product amount (per line). Margin vs vendor purchase uses the same line totals (before GST). Freight and finance roll into the vendor purchase total in the footer when entered.</p>`
}

/** @deprecated Legacy alias — uses 18% GST. Prefer {@link buildOvfCustomerChargesTableHtml}. */
export function buildOvfLineItemsTableHtml(lines: QuoteLineForm[]): string {
  return buildOvfCustomerChargesTableHtml(lines, 18)
}

export type BuildOvfHtmlOptions = {
  /** When set, block M renders as this table instead of plain text. */
  lineItemsTableHtmlForM?: string
}

/**
 * Builds block content from quote (+ optional PO). Later you can remap IDs to specific fields/buttons.
 */
export function buildOvfBlocks(
  record: SavedQuoteRecord,
): Record<OvfBlockId, string> {
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const { total } = getQuoteMoneySummary(data)
  const totalStr = total.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const lines = filterCommercialLines(data.lineItems)

  const senderSplit = getSenderOvfSplit(
    data.senderAddressPreset,
    data.quoteDate,
    data.quoteRef,
    data.validUntil,
  )

  const blocks: Record<OvfBlockId, string> = {
    A: data.quoteRef || '—',
    B: data.quoteDate || '—',
    C: data.validUntil || '—',
    D: data.customerName.trim() || '—',
    E: data.customerCompanyName.trim() || '—',
    F: data.customerAddress.trim() || '—',
    G: data.subject.trim() || '—',
    H: `${totalStr} INR (quote grand total)`,
    I: data.signatoryName.trim() || '—',
    J: senderSplit.gst,
    K: senderSplit.quoteNo,
    L: '—',
    M: lines.length === 0 ? '—' : '(Line items table — see export)',
    N: '—',
    O: '—',
    P: senderSplit.address,
    Q: '—',
    R: '—',
    S: '—',
    T: '—',
    U: '—',
    V: '—',
    W: '—',
    X: '—',
    Y: '—',
  }
  return blocks
}

/** Build printable HTML from edited block content (same layout as download). */
export function buildOvfHtmlFromBlocks(
  quoteRefLabel: string,
  blocks: Record<OvfBlockId, string>,
  options?: BuildOvfHtmlOptions,
): string {
  const ref = esc(quoteRefLabel || 'quote')
  const tableM = options?.lineItemsTableHtmlForM
  const sections = OVF_BLOCK_IDS.map((id) => {
    const isMTable = id === 'M' && tableM
    const body = isMTable ? tableM : nl2br(blocks[id])
    const bodyClass = isMTable
      ? 'ovf-block__body ovf-block__body--table'
      : 'ovf-block__body'
    return `
    <section class="ovf-block" id="block-${id}">
      <h2>Block ${id}</h2>
      <div class="${bodyClass}">${body}</div>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>OVF — ${ref}</title>
  <style>
    body { font-family: system-ui, Segoe UI, Roboto, sans-serif; line-height: 1.45; color: #0f172a; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.35rem; border-bottom: 2px solid #2563eb; padding-bottom: 0.35rem; }
    .ovf-block { margin-top: 1.25rem; page-break-inside: avoid; }
    .ovf-block h2 { font-size: 0.95rem; color: #64748b; margin: 0 0 0.35rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .ovf-block__body { white-space: pre-wrap; font-size: 0.95rem; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.65rem 0.75rem; background: #f8fafc; }
    .ovf-block__body--table { white-space: normal; padding: 0.5rem 0.65rem; }
    .ovf-line-items-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .ovf-line-items-table th, .ovf-line-items-table td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid #e2e8f0; }
    .ovf-line-items-table th { background: rgba(15, 23, 42, 0.05); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; }
    .ovf-line-items-table tbody tr:last-child td { border-bottom: none; }
    .ovf-line-items-desc { color: #64748b; font-size: 0.85rem; }
    .ovf-line-items-empty { margin: 0; color: #64748b; }
    @media print { body { margin: 0; max-width: none; } }
  </style>
</head>
<body>
  <h1>OVF — ${ref}</h1>
  <p class="muted" style="color:#64748b;font-size:0.9rem;">Blocks A–Y — from quote &amp; PO where applicable; edit before export.</p>
  ${sections}
</body>
</html>`
}

function kvRow(label: string, value: string): string {
  const cell = value.trim() ? nl2br(value) : esc('—')
  return `<tr><th scope="row">${esc(label)}</th><td>${cell}</td></tr>`
}

/** Printable HTML with named OVF fields + customer charges table. */
export function buildOvfSemanticHtml(
  linkedQuoteRef: string,
  ovfRef: string,
  fields: OvfFormFields,
  commercialLines: QuoteLineForm[],
): string {
  const gst = parseGstPercent(fields.gstPercent)
  const vendorMap = normalizeVendorPurchaseMap(fields)
  const aggEco = computeOvfAggregateEconomics(commercialLines, vendorMap)
  const vendorPurchaseSubtotal = aggEco.totalPurchase
  const freightInr = extraChargeInrFromField(
    fields.freightCharges,
    fields.freightChargesUnit,
    vendorPurchaseSubtotal,
  )
  const financeInr = extraChargeInrFromField(
    fields.financeCost,
    fields.financeCostUnit,
    vendorPurchaseSubtotal,
  )
  const marginDisp = getOvfMarginDisplayStrings(
    fields,
    commercialLines,
    aggEco,
    freightInr + financeInr,
  )
  const chargesTable = buildOvfCustomerChargesTableHtml(
    commercialLines,
    gst,
    vendorMap,
    { freightInr, financeInr },
  )
  const qref = esc(linkedQuoteRef.trim() || '—')
  const meta = [
    kvRow('OVF number', ovfRef),
    kvRow('Company PO number', fields.companyPoNumber),
    kvRow('Creation date', fields.creationDate),
    kvRow('Customer (company)', fields.customerName),
    kvRow('Product name', fields.productName),
    kvRow('Billing address', fields.billingAddress),
    kvRow('Quote number', fields.quoteNumber),
    kvRow('Billing state', fields.billingState),
    kvRow('Contact person', fields.contactPerson),
    kvRow('Contact number', fields.contactNumber),
    ...(fields.contactEmail.trim() ? [kvRow('Email', fields.contactEmail)] : []),
    kvRow('OVF module owner', fields.ovfModuleOwner),
    ...(fields.vendorPoNumber.trim() ? [kvRow('Vendor PO number', fields.vendorPoNumber)] : []),
    kvRow('Vendor name', fields.vendorName),
    ...(fields.vendorContactNumber.trim()
      ? [kvRow('Vendor contact number', fields.vendorContactNumber)]
      : []),
    ...(fields.vendorEmailId.trim() ? [kvRow('Vendor email ID', fields.vendorEmailId)] : []),
    kvRow('Margin', marginDisp.margin),
    kvRow('Margin %', marginDisp.marginPercent),
    kvRow('Country', effectiveOvfCountry(fields.country)),
    kvRow('Customer PO number', fields.customerPoNumber),
    kvRow('Shipping address', fields.shippingAddress),
    kvRow('Shipping state', fields.shippingState),
    kvRow('Delivery period', fields.deliveryPeriod),
    kvRow('Installation / service details', fields.installationServiceDetails),
    ...(fields.customerPaymentTerms.trim()
      ? [kvRow('Customer payment terms', fields.customerPaymentTerms)]
      : []),
    kvRow('Vendor payment terms', fields.vendorPaymentTerms),
    kvRow(
      'Freight charges',
      formatChargeFieldForMeta(
        fields.freightCharges,
        fields.freightChargesUnit,
        vendorPurchaseSubtotal,
        formatInr,
      ) || fields.freightCharges,
    ),
    kvRow(
      'Finance cost',
      formatChargeFieldForMeta(
        fields.financeCost,
        fields.financeCostUnit,
        vendorPurchaseSubtotal,
        formatInr,
      ) || fields.financeCost,
    ),
    kvRow('Any additional charges', fields.additionalCharges),
  ].join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>OVF — ${esc(ovfRef)}</title>
  <style>
    body { font-family: system-ui, Segoe UI, Roboto, sans-serif; line-height: 1.45; color: #0f172a; max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.35rem; border-bottom: 2px solid #2563eb; padding-bottom: 0.35rem; margin-bottom: 0.25rem; }
    .ovf-sub { color: #64748b; font-size: 0.95rem; margin: 0 0 1.25rem; }
    .ovf-section-title { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: #0f172a; }
    .ovf-meta { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
    .ovf-meta th { text-align: left; vertical-align: top; width: 38%; padding: 0.45rem 0.6rem 0.45rem 0; color: #475569; font-weight: 600; border-bottom: 1px solid #e2e8f0; }
    .ovf-meta td { padding: 0.45rem 0; border-bottom: 1px solid #e2e8f0; }
    .ovf-line-items-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    .ovf-line-items-table th, .ovf-line-items-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #e2e8f0; }
    .ovf-line-items-table th { background: rgba(15, 23, 42, 0.05); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; text-align: left; }
    .ovf-line-items-table th:not(:first-child), .ovf-num { text-align: right; }
    .ovf-line-items-table tbody tr:last-child td { border-bottom: none; }
    .ovf-line-items-totals td { border-top: 2px solid #cbd5e1; }
    .ovf-line-items-desc { color: #64748b; font-size: 0.85rem; }
    .ovf-line-items-empty { margin: 0; color: #64748b; }
    .ovf-gst-note { font-size: 0.82rem; color: #64748b; margin: 0.5rem 0 0; }
    @media print { body { margin: 0; max-width: none; } }
  </style>
</head>
<body>
  <h1>OVF — ${esc(ovfRef)}</h1>
  <p class="ovf-sub">Linked quote reference: ${qref}</p>
  <h2 class="ovf-section-title">OVF details</h2>
  <table class="ovf-meta" role="presentation">
    <tbody>${meta}</tbody>
  </table>
  <h2 class="ovf-section-title">Customer charges</h2>
  <p class="ovf-sub" style="margin-bottom:0.65rem;">Product lines from the quote; GST rate is editable in the OVF form (currently ${esc(String(gst))}%).</p>
  <div class="ovf-block__body ovf-block__body--table" style="white-space:normal;border:1px solid #e2e8f0;border-radius:8px;padding:0.5rem 0.65rem;background:#f8fafc;">
    ${chargesTable}
  </div>
</body>
</html>`
}

export function buildOvfHtmlDocument(record: SavedQuoteRecord): string {
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(data.lineItems)
  if (record.ovf) {
    return buildOvfSemanticHtml(
      data.quoteRef || record.quoteRef || 'quote',
      record.ovf.ovfRef,
      record.ovf.fields,
      commercial,
    )
  }
  const blocks = buildOvfBlocks(record)
  return buildOvfHtmlFromBlocks(data.quoteRef || 'quote', blocks, {
    lineItemsTableHtmlForM: buildOvfCustomerChargesTableHtml(commercial, 18),
  })
}

export function downloadOvf(record: SavedQuoteRecord): void {
  const html = buildOvfHtmlDocument(record)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const label = record.ovf?.ovfRef || record.quoteRef || 'ovf'
  const safe = label.replace(/[^\w.-]+/g, '_')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `OVF-${safe}.html`
  a.click()
  URL.revokeObjectURL(a.href)
}
