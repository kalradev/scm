import type { OvfFormFields, OvfMoneyUnit } from '../types/ovf'
import type { QuoteFormData } from '../types/quotePdf'
import { filterCommercialLines } from './quoteLineItems'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import {
  computeOvfAggregateEconomics,
  hasAnyVendorPurchase,
  sanitizeVendorPurchaseUnit,
} from './ovfVendorEconomics'
import { normalizeQuoteFormData } from './quoteFormDefaults'

/** Default customer country when OVF country is left blank. */
export const OVF_DEFAULT_COUNTRY = 'India' as const

/** Default vendor payment terms (OVF preset days). */
export const OVF_DEFAULT_VENDOR_PAYMENT_TERMS = '30 days' as const

/** Day counts for the vendor payment terms dropdown (stored as `{n} days`). */
export const OVF_VENDOR_PAYMENT_PRESET_DAYS = ['15', '30', '45', '60'] as const

export function vendorPaymentTermsPresetSelectValue(
  terms: string | undefined,
): (typeof OVF_VENDOR_PAYMENT_PRESET_DAYS)[number] | 'manual' {
  const t = String(terms ?? '').trim()
  for (const d of OVF_VENDOR_PAYMENT_PRESET_DAYS) {
    if (t === `${d} days`) return d
  }
  return 'manual'
}

/**
 * Map messy phrases ("30 days from invoice", "Net 45") to OVF dropdown values (`{n} days`)
 * when n is one of {@link OVF_VENDOR_PAYMENT_PRESET_DAYS}.
 */
export function normalizeExtractedPaymentTermsForOvf(raw: string | undefined): string | undefined {
  const t = String(raw ?? '').trim()
  if (!t) return undefined
  for (const d of OVF_VENDOR_PAYMENT_PRESET_DAYS) {
    if (t === `${d} days`) return `${d} days`
  }
  let n =
    t.match(/\bNet\s*(\d{1,3})\s*(?:days?|D)?\b/i)?.[1] ??
    t.match(/\b(?:within|due\s*(?:in|within)?)\s*(\d{1,3})\s*days?\b/i)?.[1]
  if (!n) {
    const phrase = t.match(/\b(\d{1,3})\s*days?\s*(?:from|after|credit|from\s+the\s+date)/i)
    if (phrase?.[1]) n = phrase[1]
  }
  if (!n) {
    const standalone = t.match(/\b(15|30|45|60)\s*days?\b/i)
    if (standalone?.[1]) n = standalone[1]
  }
  if (
    n &&
    OVF_VENDOR_PAYMENT_PRESET_DAYS.includes(n as (typeof OVF_VENDOR_PAYMENT_PRESET_DAYS)[number])
  ) {
    return `${n} days`
  }
  return t.length > 90 ? `${t.slice(0, 87)}…` : t
}

export function effectiveOvfCountry(raw: string | undefined): string {
  const t = String(raw ?? '').trim()
  return t || OVF_DEFAULT_COUNTRY
}

function normalizeOvfMoneyUnit(raw: unknown): OvfMoneyUnit {
  return raw === 'percent' ? 'percent' : 'inr'
}

export function withDefaultOvfCountry(fields: OvfFormFields): OvfFormFields {
  return { ...fields, country: effectiveOvfCountry(fields.country) }
}

/** Merge stored / partial OVF fields with defaults; maps legacy `poNumber` → `customerPoNumber`. */
export function normalizeOvfFieldsFromStorage(raw: unknown): OvfFormFields {
  const empty = createEmptyOvfFields()
  if (!raw || typeof raw !== 'object') return empty
  const r = { ...(raw as Record<string, unknown>) }
  const legacyPo = String(r.poNumber ?? '').trim()
  delete r.poNumber
  const merged = { ...empty, ...(r as unknown as Partial<OvfFormFields>) }
  if (!String(merged.customerPoNumber ?? '').trim() && legacyPo) {
    merged.customerPoNumber = legacyPo
  }
  merged.freightChargesUnit = normalizeOvfMoneyUnit(merged.freightChargesUnit)
  merged.financeCostUnit = normalizeOvfMoneyUnit(merged.financeCostUnit)
  if (!String(merged.vendorPaymentTerms ?? '').trim()) {
    merged.vendorPaymentTerms = OVF_DEFAULT_VENDOR_PAYMENT_TERMS
  }
  return merged
}

export function createEmptyOvfFields(): OvfFormFields {
  return {
    creationDate: '',
    customerName: '',
    customerGstin: '',
    productName: '',
    billingAddress: '',
    quoteNumber: '',
    billingState: '',
    contactPerson: '',
    contactNumber: '',
    contactEmail: '',
    vendorPoNumber: '',
    vendorContactNumber: '',
    vendorEmailId: '',
    ovfModuleOwner: '',
    vendorDirectoryId: '',
    vendorAddressId: '',
    vendorAddressDetail: '',
    vendorName: '',
    margin: '',
    marginPercent: '',
    country: OVF_DEFAULT_COUNTRY,
    customerPoNumber: '',
    companyPoNumber: '',
    shippingAddress: '',
    shippingState: '',
    deliveryPeriod: '',
    installationServiceDetails: '',
    customerPaymentTerms: '',
    vendorPaymentTerms: OVF_DEFAULT_VENDOR_PAYMENT_TERMS,
    freightCharges: '',
    freightChargesUnit: 'inr',
    financeCost: '',
    financeCostUnit: 'inr',
    additionalCharges: '',
    gstPercent: '18',
    vendorPurchaseUnitByLineId: {},
  }
}

function todayIsoDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Name shown on the quote as signatory (PDF “Thank you” block), else the
 * display name captured when the quote was finalized.
 */
export function quoteSignatureOwnerLabel(record: SavedQuoteRecord): string {
  const signatory = String(record.formSnapshot.signatoryName ?? '').trim()
  if (signatory) return signatory
  return String(record.savedByDisplayName ?? '').trim()
}

function productSummaryFromQuote(data: QuoteFormData): string {
  const lines = filterCommercialLines(data.lineItems)
  const names = lines
    .map((ln) => (ln.product || '').trim())
    .filter(Boolean)
  if (names.length === 0) return ''
  if (names.length <= 2) return names.join(', ')
  return `${names[0]}, ${names[1]} (+${names.length - 2} more)`
}

/**
 * First-time prefill when an OVF is created for a finalized quote (+ attached PO).
 * Copies supplier invoice line rates from `vendorUnitPrice` on quote lines into OVF
 * `vendorPurchaseUnitByLineId` so vendor purchase + margin tables populate.
 * Customer company name and billing/shipping addresses are left blank here so Sales
 * fills them from the customer PO (upload + AI extraction on the OVF screen), not from
 * the quote recipient block.
 */
export function buildOvfPrefillFromQuote(record: SavedQuoteRecord): OvfFormFields {
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const empty = createEmptyOvfFields()
  const commercial = filterCommercialLines(data.lineItems)

  const vendorPurchaseUnitByLineId: Record<string, string> = {}
  for (const ln of commercial) {
    const vu = ln.vendorUnitPrice
    if (vu !== undefined && String(vu).trim() !== '') {
      vendorPurchaseUnitByLineId[ln.id] = sanitizeVendorPurchaseUnit(String(vu).trim())
    }
  }

  let margin = ''
  let marginPercent = ''
  if (hasAnyVendorPurchase(commercial, vendorPurchaseUnitByLineId)) {
    const agg = computeOvfAggregateEconomics(commercial, vendorPurchaseUnitByLineId)
    const marginInr = agg.totalSell - agg.totalPurchase
    const marginPct =
      agg.totalSell > 0 ? (marginInr / agg.totalSell) * 100 : null
    if (Number.isFinite(marginInr)) {
      margin = marginInr.toFixed(2)
    }
    if (marginPct != null && Number.isFinite(marginPct)) {
      marginPercent = marginPct.toFixed(2)
    }
  }

  const recipient = data.customerName.trim()
  const company = data.customerCompanyName.trim()

  return {
    ...empty,
    creationDate: todayIsoDate(),
    customerName: '',
    contactPerson: company ? recipient : '',
    productName: productSummaryFromQuote(data),
    billingAddress: '',
    quoteNumber: (data.quoteRef || record.quoteRef || '').trim(),
    shippingAddress: '',
    /** Customer PO ref from the uploaded PO file when present. */
    customerPoNumber: (record.po?.customerPoNumber ?? '').trim(),
    /** Quote PDF signatory, else creator display name stored on the quote. */
    ovfModuleOwner: quoteSignatureOwnerLabel(record),
    vendorPurchaseUnitByLineId,
    margin,
    marginPercent,
  }
}
