import type { ScmPoLine, ScmPoStoredState } from '../types/scmPo'
import { filterCommercialLines } from './quoteLineItems'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import { getVendorForUser } from './vendorsStorage'
import { COMPANY_DELIVERY_LOCATIONS, getCompanyLocationById } from './companyLocations'
import { getScmPoDefaultBillingAddressForPdf } from './scmPoLetterhead'
import {
  defaultPoType,
  mergeQuoteProductAndDescriptionForItemDetails,
  normalizeScmPoLine,
} from './scmPoLine'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import type { QuoteFormData } from '../types/quotePdf'

function coalesceText(
  ...vals: (string | number | undefined | null)[]
): string {
  for (const v of vals) {
    if (v == null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

function firstTextLine(s: string): string {
  const line = String(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? ''
}

function toYyyyMmDdIfPossible(raw: string | undefined | null): string {
  if (raw == null) return ''
  const t = String(raw).trim()
  if (!t) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const ms = Date.parse(t)
  if (Number.isNaN(ms)) return t
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * If `f.deliveryPeriod` looks like a full/partial date, normalize; else keep PO
 * (usually free text and should not be forced into a date).
 */
function deliveryDateWithOvfFallback(
  poStr: string,
  deliveryPeriod: string,
): string {
  const t = toYyyyMmDdIfPossible(coalesceText(poStr))
  if (t) return t
  const p = (deliveryPeriod || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(p) || p.includes('/')) {
    return toYyyyMmDdIfPossible(p) || p
  }
  return poStr
}

function linesFromQuote(
  record: SavedQuoteRecord,
  gst: string,
): ScmPoLine[] {
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(data.lineItems)
  return commercial
    .map((ln) => {
      const prod = ln.product.trim()
      const desc = ln.description.trim()
      const itemDetails = mergeQuoteProductAndDescriptionForItemDetails(
        ln.product,
        ln.description,
      )
      if (!prod && !desc) return null
      return normalizeScmPoLine({
        // Preserve quote line id so we can map to OVF vendor purchase units.
        id: ln.id,
        itemDetails: itemDetails || prod || desc,
        partNumber: prod,
        poType: defaultPoType(),
        quantity: ln.qty,
        rate: ln.unitPrice,
        tax: gst,
      })
    })
    .filter(Boolean) as ScmPoLine[]
}

function linesFromOvfVendor(
  record: SavedQuoteRecord,
  gst: string,
): ScmPoLine[] {
  const ovf = record.ovf
  if (!ovf) return []
  const vendorUnitByLineId = (ovf.fields.vendorPurchaseUnitByLineId ??
    {}) as Record<string, string | undefined>
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(data.lineItems)
  return commercial
    .map((ln) => {
      const prod = ln.product.trim()
      const desc = ln.description.trim()
      const itemDetails = mergeQuoteProductAndDescriptionForItemDetails(
        ln.product,
        ln.description,
      )
      if (!prod && !desc) return null
      return normalizeScmPoLine({
        // Preserve quote line id so we can map to OVF vendor purchase units.
        id: ln.id,
        itemDetails: itemDetails || prod || desc,
        partNumber: prod,
        poType: defaultPoType(),
        quantity: ln.qty,
        rate: String(vendorUnitByLineId[ln.id] ?? '').trim(),
        tax: gst,
      })
    })
    .filter(Boolean) as ScmPoLine[]
}

function isLineRowBlank(line: ScmPoLine): boolean {
  return (
    !String(line.itemDetails).trim() &&
    !String(line.partNumber).trim() &&
    !String(line.quantity).trim() &&
    !String(line.rate).trim()
  )
}

const emptyLine: () => ScmPoLine = () => ({
  id: crypto.randomUUID(),
  itemDetails: '',
  partNumber: '',
  hsnCode: '',
  poType: defaultPoType(),
  quantity: '',
  rate: '',
  tax: '18',
})

/**
 * Fills only **empty** PO fields from OVF/quote. Used when re-opening a draft PO
 * and for Excel export so values already in OVF/quote are not left blank in columns.
 */
export function mergeScmPoGapsFromOvfAndQuote(
  record: SavedQuoteRecord,
  po: ScmPoStoredState,
): ScmPoStoredState {
  const ovf = record.ovf
  if (!ovf) return po
  const f = ovf.fields
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  // Default GST for new/blank PO lines is 18% (SCM can adjust in the editor).
  const gst = '18'
  const vDir = coalesceText(po.vendorDirectoryId, f.vendorDirectoryId)
  const v = vDir ? getVendorForUser(vDir, record.savedBy) : undefined
  const addrIdOvf = f.vendorAddressId?.trim() ?? ''
  const addrFromDir =
    v && addrIdOvf
      ? (v.addresses.find((a) => a.id === addrIdOvf)?.lines ?? '')
      : v
        ? (v.addresses[0]?.lines ?? '')
        : ''
  const preferredAddrId = coalesceText(
    (po.vendorAddressId || '').trim() ? po.vendorAddressId : '',
    f.vendorAddressId,
    v?.addresses[0]?.id,
  )

  let linesOut = po.lines
  if (po.lines.length === 0 || po.lines.every(isLineRowBlank)) {
    const fromVendor = linesFromOvfVendor(record, gst)
    const fromQ = linesFromQuote(record, gst)
    const preferred = fromVendor.length > 0 ? fromVendor : fromQ
    if (preferred.length > 0) linesOut = preferred
    else if (po.lines.length === 0) {
      const line = emptyLine()
      line.tax = gst
      linesOut = [line]
    }
  }

  // If this is an SCM draft (no PO ref yet) and OVF has vendor purchase units,
  // ensure the line "Rate (INR)" reflects vendor units (not customer sell).
  // For older drafts where PO line ids were random (not quote line ids), fall back to line order.
  const vendorUnitByLineId = (f.vendorPurchaseUnitByLineId ??
    {}) as Record<string, string | undefined>
  const hasAnyVendorUnit = Object.values(vendorUnitByLineId).some(
    (v) => String(v ?? '').trim() !== '',
  )
  if (hasAnyVendorUnit && !String(po.poRef ?? '').trim()) {
    const commercial = filterCommercialLines(data.lineItems)
    if (commercial.length > 0 && linesOut.length > 0) {
      const byId = new Map(commercial.map((ln) => [ln.id, ln]))
      linesOut = linesOut.map((line, idx) => {
        const quoteLine = byId.get(line.id) ?? commercial[idx]
        if (!quoteLine) return line
        const nextRate = String(vendorUnitByLineId[quoteLine.id] ?? '').trim()
        if (!nextRate) return line
        const curRate = String(line.rate ?? '').trim()
        const curLooksLikeCustomer =
          !curRate || curRate === String(quoteLine.unitPrice ?? '').trim()
        return curLooksLikeCustomer ? { ...line, rate: nextRate } : line
      })
    }
  }

  const locForShip = getCompanyLocationById(
    (po.companyLocationId || '').trim() ||
      COMPANY_DELIVERY_LOCATIONS[0]?.id ||
      '',
  )
  const shipFromLoc = (locForShip?.address ?? '').trim()

  const resolvedCompanyLocationId = (() => {
    if ((po.companyLocationId || '').trim()) return po.companyLocationId
    return COMPANY_DELIVERY_LOCATIONS[0]?.id ?? po.companyLocationId
  })()

  return {
    ...po,
    vendorDirectoryId: vDir,
    vendorAddressId: preferredAddrId,
    vendorNameSnapshot: coalesceText(po.vendorNameSnapshot, f.vendorName, v?.name),
    vendorAddressSnapshot: coalesceText(
      po.vendorAddressSnapshot,
      f.vendorAddressDetail,
      v && (preferredAddrId || '').trim()
        ? (v.addresses.find((a) => a.id === preferredAddrId?.trim())?.lines ??
            addrFromDir)
        : addrFromDir,
    ),
    sourceOfSupply: coalesceText(
      po.sourceOfSupply,
      f.billingState,
      f.country,
      firstTextLine(f.vendorAddressDetail),
    ),
    destinationOfSupply: coalesceText(
      po.destinationOfSupply,
      f.shippingState,
      firstTextLine(f.shippingAddress),
    ),
    companyLocationId: resolvedCompanyLocationId,
    poCompanyAddress: coalesceText(
      po.poCompanyAddress,
      shipFromLoc,
      getScmPoDefaultBillingAddressForPdf(),
    ),
    purchaseDate: (() => {
      const a = toYyyyMmDdIfPossible(po.purchaseDate)
      if (a) return a
      const b = toYyyyMmDdIfPossible(f.creationDate) || toYyyyMmDdIfPossible(data.quoteDate)
      if (b) return b
      return new Date().toISOString().slice(0, 10)
    })(),
    deliveryDate: deliveryDateWithOvfFallback(
      po.deliveryDate,
      f.deliveryPeriod,
    ),
    customerPoNumber: coalesceText(po.customerPoNumber, f.customerPoNumber),
    customerName: coalesceText(
      po.customerName,
      f.customerName,
      data.customerName,
    ),
    customerGstin: coalesceText(
      (po as unknown as { customerGstin?: string }).customerGstin,
      (f as unknown as { customerGstin?: string }).customerGstin,
    ),
    quoteNumber: coalesceText(
      po.quoteNumber,
      f.quoteNumber,
      data.quoteRef,
      record.quoteRef,
    ),
    companyPoNumber: coalesceText(po.companyPoNumber, f.companyPoNumber),
    ovfNumber: coalesceText(po.ovfNumber, ovf.ovfRef),
    customerPoDate: toYyyyMmDdIfPossible(po.customerPoDate),
    ovfApprover: coalesceText(
      po.ovfApprover,
      ovf.financeApprovedBy,
    ),
    poBillingAddress: coalesceText(
      po.poBillingAddress,
      getScmPoDefaultBillingAddressForPdf(),
    ),
    poShippingAddress: (() => {
      const s = coalesceText(
        po.poShippingAddress,
        shipFromLoc,
        String(f.shippingAddress ?? '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim(),
      )
      return s || getScmPoDefaultBillingAddressForPdf()
    })(),
    lines: linesOut,
  }
}

/**
 * Shipped lines summary for export: PO lines first; if the summary is empty, quote commercial lines.
 */
export function lineItemsExportSummary(
  record: SavedQuoteRecord,
  po: ScmPoStoredState,
): string {
  const n = (line: ScmPoLine) => {
    const x = normalizeScmPoLine(line)
    const bits = [x.partNumber, x.itemDetails]
      .map((s) => s.trim())
      .filter(Boolean)
    return bits.join(' — ')
  }
  const fromPo = po.lines.map(n).filter(Boolean).join(' | ')
  if (fromPo) return fromPo
  if (!record.ovf) return ''
  const f = record.ovf.fields
  const gst = String(f.gstPercent ?? '18').trim() || '18'
  const fromQuote = linesFromQuote(record, gst)
    .map(n)
    .filter(Boolean)
    .join(' | ')
  return fromQuote
}
