import type { OvfFormFields, OvfProofAttachment } from '../types/ovf'
import { extractPoNumberFromPlainText } from './extractPoNumber'
import { extractInvoiceRawTextForFooterScan, extractPoRawTextForPartyScan } from './extractInvoiceLineItems'
import { proofAttachmentBlobAsync, quotePoBlob } from './quoteExport'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import {
  OVF_DEFAULT_VENDOR_PAYMENT_TERMS,
  normalizeExtractedPaymentTermsForOvf,
} from './ovfFormDefaults'

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
/**
 * Indian mobile + STD + US-style numbers (many supplier invoices are US/EU letterhead).
 * Used for best-effort vendor phone from supplier invoice PDF text.
 */
const PHONE_IN =
  /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|(?:\+91[\s-]?)?[6-9]\d{9}\b|(?:\+91[\s-]?)?(?:\d{2,4})[-\s]?\d{6,8}\b|0\d{2,4}[-\s]?\d{6,8}\b/g

function normalizePhoneCandidate(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\u00a0/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '')
    .replace(/(?!^\+)[^\d]/g, '') // keep leading '+' only
}

function isLikelyPhoneCandidate(raw: string): boolean {
  const t = normalizePhoneCandidate(raw)
  if (!t) return false
  const digits = t.replace(/^\+/, '')
  if (!/^\d+$/.test(digits)) return false
  // Reject obvious money / IDs accidentally matched as "0xxxx..." sequences.
  if (/^0{3,}/.test(digits)) return false
  if (/^(?:0+1+5+0+0+0+0+|0+2+5+0+0+0+0+)/.test(digits)) return false
  // Reject "mostly zeros" like 0000150000 (>=60% zeros).
  const zeros = (digits.match(/0/g) ?? []).length
  if (digits.length >= 8 && zeros / digits.length >= 0.6) return false
  // Length sanity: allow +91 mobile (10), IN landline-ish (10–12), US (10).
  if (digits.length < 10 || digits.length > 12) return false
  // Prefer mobile rule: Indian mobiles start 6–9.
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return true
  // Accept landline-ish only if it starts with 0 and has enough non-zero digits.
  if (digits.startsWith('0')) {
    const nonZero = digits.length - zeros
    return nonZero >= 5
  }
  // Fallback: US-style 10 digits.
  return digits.length === 10
}

function pickFirstLikelyPhone(rawText: string): string | undefined {
  const phones = rawText.match(PHONE_IN) ?? []
  for (const p of phones) {
    if (isLikelyPhoneCandidate(p)) return normalizePhoneCandidate(p)
  }
  return undefined
}

export type VendorPartyHints = Partial<
  Pick<
    OvfFormFields,
    | 'vendorName'
    | 'vendorAddressDetail'
    | 'vendorPoNumber'
    | 'vendorContactNumber'
    | 'vendorEmailId'
    | 'vendorPaymentTerms'
  >
>

export type CustomerPartyHints = Partial<
  Pick<
    OvfFormFields,
    | 'customerName'
    | 'contactPerson'
    | 'customerPoNumber'
    | 'billingAddress'
    | 'shippingAddress'
    | 'billingState'
    | 'shippingState'
    | 'contactNumber'
    | 'contactEmail'
    | 'customerPaymentTerms'
  >
>

function cleanLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Standalone section titles (often printed above the real company name) — never a legal entity name.
 */
export function isSpuriousVendorCompanyNameCandidate(
  s: string | undefined | null,
): boolean {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return true
  if (t.length > 48) return false
  return /^(contact|attention|address|phone|telephone|tel|mobile|email|e-?mail|fax|details?|office|location|vendor|supplier|sold\s*by|from)$/i.test(
    t,
  )
}

/** Totals / tax rows (often mistaken for a supplier name when OCR merges tables). */
export function isFinancialTableNoiseVendorName(
  s: string | undefined | null,
): boolean {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return true
  if (/\b(?:tax|gst|cgst|sgst|igst|vat|cess)\s*\(/i.test(t)) return true
  if (/\b(?:sub\s*total|grand\s*total|total\s*amount|net\s*(?:amount|payable)|balance\s*due|amount\s*payable|round\s*off)\b/i.test(t)) {
    return true
  }
  if (/\d{1,3}\s*%/.test(t) && /[\d,]{3,}/.test(t.replace(/\s/g, ''))) return true
  if (/^[₹Rs.]?\s*[\d,]+(?:\.\d{2})?\s*$/i.test(t.trim())) return true
  return false
}

/** Combined guard for vendor display name (headings + invoice math lines). */
export function isInvalidExtractedVendorDisplayName(
  s: string | undefined | null,
): boolean {
  return (
    isSpuriousVendorCompanyNameCandidate(s) ||
    isFinancialTableNoiseVendorName(s)
  )
}

/** Rough signal that a Bill-to line looks like an organization vs a lone informal person. */
function looksLikeBuyerOrganizationName(line: string): boolean {
  const t = line.trim()
  if (t.length < 3) return false
  if (
    /\b(?:pvt\.?\s*ltd\.?|private\s+limited|\(p\)|\blimited\b|\bllp\b|\bltd\.?\b|\bllc\b|\bplc\b|\binc\.?\b|\bcorp\b|\bcorporation\b|\btechnologies\b|\bhealthcare\b|\bhospital(?:s)?\b)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/&/.test(t) && t.length >= 14) return true
  return t.length >= 48
}

/** Lines that are clearly not a supplier legal name (dates, phones, URLs, etc.). */
function isVendorNameNoiseLine(l: string): boolean {
  const t = l.trim()
  if (isSpuriousVendorCompanyNameCandidate(t)) return true
  if (isFinancialTableNoiseVendorName(t)) return true
  if (t.length < 2 || t.length > 120) return true
  if (/^(invoice|tax\s*invoice|bill|page|date|due|amount|total|sub\s*total|thank|balance)/i.test(t)) {
    return true
  }
  // Line-item table rows sometimes look like: "2 hp RX100 40000" (qty + item + amount).
  // Never treat those as a supplier legal name.
  if (
    /^\d{1,6}\s+\S.{0,80}\s+\d[\d,]*(?:\.\d+)?\s*$/i.test(t) &&
    /\d[\d,]*(?:\.\d+)?\s*$/.test(t)
  ) {
    return true
  }
  // Table header rows (common in OCR/PDF extraction).
  if (/^(qty|quantity)\s+item\s+description\s+cost$/i.test(t)) return true
  if (/^(sr\.?\s*no|s\.?\s*no|#)\s+qty\b/i.test(t)) return true
  // Our own (Cache) letterhead/address should never become a vendor name.
  if (isOurSellerPostalBlock(t) || /\bkailash\s*colony\b/i.test(t)) return true
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(t)) return true
  if (/\bdue\s*:/i.test(t) && /\d{1,2}[\/\-]/.test(t)) return true
  if (/^(tel|phone|mob|mobile|fax|email)\s*:/i.test(t)) return true
  if (/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(t)) return true
  if (/(?:\+91[\s.-]?)?[6-9]\d{9}\b/.test(t.replace(/\s/g, ''))) return true
  if (/^www\.|^https?:\/\//i.test(t)) return true
  if (/^[\d\s.-]+$/.test(t)) return true
  return false
}

function cleanVendorNameCandidate(raw: string | undefined): string {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (isInvalidExtractedVendorDisplayName(t)) return ''
  // Strong guards: never accept our own letterhead or something that looks like an address/locality.
  if (isOurSellerPostalBlock(t) || /\bkailash\s*colony\b/i.test(t)) return ''
  if (isLikelyAddressLine(t)) return ''
  if (isVendorNameNoiseLine(t)) return ''
  // Extra guard: avoid "qty item description cost" variants.
  if (/\bqty\b/i.test(t) && /\bdescription\b/i.test(t) && /\bcost\b/i.test(t)) return ''
  return t.slice(0, 120)
}

/** Street / city lines that usually sit under the seller letterhead (US + common IN patterns). */
function isLikelyAddressLine(l: string): boolean {
  const t = l.trim()
  return (
    /^\d+\s+.+\b(Avenue|Ave\.?|Street|St\.?|Road|Rd\.?|Boulevard|Blvd|Lane|Drive|Dr\.?|Way|Nagar|Layout|Circle|Plaza|Park)\b/i.test(
      l,
    ) ||
    /,\s*[A-Za-z][A-Za-z\s]{2,40},\s*[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(l) ||
    /\b[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/.test(t) ||
    /\b[A-Za-z][a-zA-Z0-9\s,.-]{2,48}\s+\d{6}\s*$/.test(t)
  )
}

/**
 * When PDFs have no GSTIN / “Seller:” labels (US templates), infer supplier name from
 * letterhead order: company line above phone / website / street address.
 * Note: text baked only into images (logos) will not appear — OCR must supply it.
 */
function guessVendorNameFromLetterhead(lines: string[]): string | undefined {
  const max = Math.min(lines.length, 80)

  for (let i = 0; i < max; i++) {
    const l = lines[i]
    const labeled = l.match(
      /^(?:company|organization|business|legal\s*name|registered\s*name)\s*[:\\-]\s*(.+)$/i,
    )
    if (labeled?.[1]?.trim()) {
      return cleanLine(labeled[1]).slice(0, 120)
    }
  }

  for (let i = 1; i < max; i++) {
    if (!isLikelyAddressLine(lines[i])) continue
    const window: string[] = []
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      const cand = lines[j]
      if (isVendorNameNoiseLine(cand)) continue
      window.push(cand)
    }
    const looksLikePersonOnly = (s: string) => {
      const t = s.trim()
      return (
        /^[A-Z][a-z]+\s+[A-Z][a-z.]+$/.test(t) &&
        !/\b(LLC|Inc\.?|Ltd\.?|Pvt\.?|Pte\.?|Corp\.?|LLP|Group|Media|Co\.?)\b/i.test(t)
      )
    }
    for (const cand of window) {
      if (!looksLikePersonOnly(cand)) return cand.slice(0, 120)
    }
    if (window[0]) return window[0].slice(0, 120)
  }

  for (let i = 1; i < max; i++) {
    if (!/^www\.|^https?:\/\//i.test(lines[i])) continue
    const prev = lines[i - 1]
    if (prev && !isVendorNameNoiseLine(prev)) return prev.slice(0, 120)
  }

  return undefined
}

/**
 * Heuristic header scan on full invoice text (PDF/Excel/OCR) for supplier party.
 */
export function parseVendorPartyFromInvoiceText(raw: string): VendorPartyHints {
  const text = raw.replace(/\r\n/g, '\n')
  const full = text.replace(/\s+/g, ' ').trim()
  const out: VendorPartyHints = {}

  for (const re of [
    /\b(?:Tax\s*Invoice|Invoice|Bill)\s*(?:No|Number|#)\s*[:\s.]*([A-Za-z0-9][A-Za-z0-9/_-]{0,48})/i,
    /\b(?:Supplier|Vendor)\s*(?:Invoice|Ref|IN)\s*[:\s#]*([A-Za-z0-9][A-Za-z0-9/_-]{0,48})/i,
  ]) {
    const m = full.match(re)
    if (m?.[1] && m[1].length > 1) {
      out.vendorPoNumber = m[1].trim()
      break
    }
  }

  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  // "Contact" / "Address" as a lone heading with the company on the next line (common on simple POs).
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    if (!/^contact\s*:?$/i.test(lines[i])) continue
    const next = lines[i + 1]
    const cleaned = cleanVendorNameCandidate(next)
    if (cleaned) {
      out.vendorName = cleaned
      break
    }
  }

  if (!out.vendorName) {
    for (let i = 0; i < Math.min(lines.length, 90); i++) {
      const l = lines[i]
      if (
        /^(seller|sold\s*by|supplier(?!'s)|vendor|from|billed\s*by|details\s*of\s*supplier|dispatch\s*from|consignor)\b/i.test(
          l,
        ) &&
        /[:\-]/.test(l)
      ) {
        const after = l.split(/[:\-]/).slice(1).join(':').trim()
        const cleanedAfter = cleanVendorNameCandidate(after)
        if (cleanedAfter.length > 2) {
          out.vendorName = cleanedAfter
          break
        }
        const n = lines[i + 1]
        const cleanedNext = cleanVendorNameCandidate(n)
        if (cleanedNext && !/gstin|phone|email|www\./i.test(n)) {
          out.vendorName = cleanedNext
          break
        }
      }
    }
  }

  if (!out.vendorName) {
    for (let i = 0; i < Math.min(lines.length, 18); i++) {
      const l = lines[i]
      if (l.length < 4 || l.length > 100) continue
      if (/^(invoice|tax|bill|date|po|order|www\.|e-?way|irn)\b/i.test(l)) continue
      if (/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/.test(l)) {
        if (i > 0) {
          const prev = lines[i - 1]
          const cleanedPrev = cleanVendorNameCandidate(prev)
          if (cleanedPrev.length > 2) out.vendorName = cleanedPrev
        }
        break
      }
    }
  }

  if (!out.vendorName) {
    const guessed = guessVendorNameFromLetterhead(lines)
    const cleaned = cleanVendorNameCandidate(guessed)
    if (cleaned) out.vendorName = cleaned
  }

  // Best-effort: try to capture the supplier address block.
  // Many invoices have: "Sold By / Supplier / From:" followed by a multi-line address.
  if (!out.vendorAddressDetail) {
    const addrNoise =
      /^(gstin|gst\s*in|pan|email|e-?mail|phone|mobile|tel|website|www\.|invoice|tax\s*invoice|bill|date|irn|ack|place\s*of\s*supply)\b/i
    const keepish = (l: string) => {
      const t = cleanLine(l)
      if (!t) return false
      if (addrNoise.test(t)) return false
      // avoid capturing a pure party label line again
      if (/^(seller|sold\s*by|supplier(?!'s)|vendor|from|billed\s*by|dispatch\s*from|consignor)\b/i.test(t)) {
        return false
      }
      return true
    }

    const addrBlock = blockAfterLabel(
      lines,
      /^(seller|sold\s*by|supplier(?!'s)|vendor|from|billed\s*by|dispatch\s*from|consignor|address)\b/i,
    )
      .map(cleanLine)
      .filter(Boolean)

    // Prefer lines that look like address, but don't require it (many invoices are messy OCR).
    const preferred = addrBlock.filter((l) => isLikelyAddressLine(l) && keepish(l))
    const fallback = addrBlock.filter((l) => keepish(l))
    const take = (preferred.length >= 2 ? preferred : fallback).slice(0, 8)
    const joined = joinAddress(take)
    const looksReal =
      joined.split(/\n/).filter(Boolean).length >= 2 ||
      /\b\d{6}\b/.test(joined) ||
      /\b(road|rd\.?|street|st\.?|lane|ln\.?|sector|block|building|bldg|floor|flat|plot|near)\b/i.test(
        joined,
      )
    if (joined.length >= 10 && looksReal) out.vendorAddressDetail = joined
  }

  if (!out.vendorAddressDetail) {
    const footerAddr = tryVendorAddressFromFooterContactBlock(lines)
    if (footerAddr) out.vendorAddressDetail = footerAddr
  }

  /** Prefer email that appears after seller / supplier cues (buyer email often appears earlier). */
  let vendorEmail: string | undefined
  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const l = lines[i]
    if (
      /^(seller|sold\s*by|supplier|vendor|from|dispatch\s*from|details\s*of\s*supplier)\b/i.test(
        l,
      )
    ) {
      const slice = lines.slice(i, Math.min(i + 12, lines.length)).join('\n')
      const em = slice.match(EMAIL_RE)
      if (em?.[0]) {
        vendorEmail = em[0]
        break
      }
    }
  }
  const emails = full.match(EMAIL_RE)
  out.vendorEmailId = vendorEmail ?? emails?.[0]

  const phone = pickFirstLikelyPhone(full)
  if (phone) out.vendorContactNumber = phone.replace(/^\+91-?/, '+91')

  const netM = full.match(/\bNet\s*(\d{1,3})\s*(?:days?|D)\b/i)
  if (netM?.[1]) {
    out.vendorPaymentTerms = `${netM[1]} days`
  } else {
    const pt = full.match(
      /\b(?:payment\s*terms?|credit\s*(?:period|days))\s*[:\s]*([^\n]{3,80})/i,
    )
    if (pt?.[1]) {
      const t = cleanLine(pt[1]).replace(/\s*(due|from).*$/i, '').trim()
      if (t.length >= 2 && t.length < 90) out.vendorPaymentTerms = t
    }
  }

  if (out.vendorPaymentTerms) {
    const norm = normalizeExtractedPaymentTermsForOvf(out.vendorPaymentTerms)
    if (norm) out.vendorPaymentTerms = norm
  }

  return out
}

const SECTION_END =
  /^(ship\s*to|deliver(?:y)?\s*to|consignee|line\s*items?|sr\.?\s*no\.?|description|qty|quantity|product\s*code|amount|sub\s*total|grand\s*total|tax\s*invoice|kind\s*attention|tax\s*\(|cgst|sgst|igst|gst\s*\(|net\s*amount|balance\s*due)/i

function blockAfterLabel(
  lines: string[],
  labelRe: RegExp,
): string[] {
  const idx = lines.findIndex((l) => labelRe.test(l))
  if (idx < 0) return []
  const out: string[] = []
  const first = lines[idx]
  const inline = first.replace(labelRe, '').replace(/^[:\s\-]+/, '').trim()
  if (inline.length > 3 && inline.length < 200 && !SECTION_END.test(inline)) {
    out.push(inline)
  }
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j]
    if (SECTION_END.test(line)) break
    if (line.length > 220) break
    out.push(line)
    if (out.length >= 16) break
  }
  return out
}

function joinAddress(lines: string[]): string {
  return lines.map(cleanLine).filter(Boolean).join('\n').trim()
}

/** Non-global — safe for repeated `.test()` (unlike `EMAIL_RE` with `/g`). */
const EMAIL_LINE_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i

function lineLooksLikeFooterPhone(l: string): boolean {
  const c = l.replace(/\s/g, '')
  return (
    /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(c) ||
    /(?:\+91[\s-]?)?[6-9]\d{9}/.test(c) ||
    /(?:\+91[\s-]?)?(?:\d{2,4})[-\s]?\d{6,8}/.test(c) ||
    /^0\d{2,4}[-\s]?\d{6,8}/.test(c)
  )
}

function lineIsFooterContactOnly(l: string): boolean {
  return EMAIL_LINE_RE.test(l) || lineLooksLikeFooterPhone(l)
}

const FOOTER_UP_STOP =
  /^(sub\s*total|less\s*deposit|balance\s*due|total\s*due|grand\s*total|amount\s*payable|tax\s*invoice|invoice\s*(?:no|number|#)?|date\s*[:]|payment\s*terms?)\b/i

function isFooterWalkStopLine(l: string): boolean {
  const t = l.trim()
  if (!t) return true
  if (FOOTER_UP_STOP.test(t)) return true
  if (/thank\s*you/i.test(t)) return true
  if (/all\s+remaining\s+amounts/i.test(t)) return true
  if (t.length > 100) return true
  if (/^(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{2})?\s*$/i.test(t) && !/[a-z]/i.test(t)) {
    return true
  }
  if (
    t.length >= 14 &&
    /^[A-Z0-9][A-Z0-9\s&'./-]{12,}$/.test(t) &&
    !/\d{6}/.test(t) &&
    !/[a-z]{2,}/.test(t)
  ) {
    return true
  }
  return false
}

/**
 * Many invoices put supplier name + city/PIN only in the bottom-right contact block (after totals).
 * `blockAfterLabel` stops at "Subtotal" / line items, so that region is never seen there.
 */
function tryVendorAddressFromFooterContactBlock(lines: string[]): string | undefined {
  if (lines.length < 2) return undefined
  const tail = lines.slice(-45)
  let anchor = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]
    if (EMAIL_LINE_RE.test(l) || lineLooksLikeFooterPhone(l)) {
      anchor = i
      break
    }
  }
  if (anchor < 0) return undefined

  const block: string[] = []
  for (let i = anchor - 1; i >= 0 && block.length < 6; i--) {
    const l = cleanLine(tail[i])
    if (!l) continue
    if (isFooterWalkStopLine(l)) break
    if (lineIsFooterContactOnly(l)) continue
    block.unshift(l)
  }

  const joined = joinAddress(block)
  if (joined.length < 6) return undefined
  const ok =
    /\b\d{6}\b/.test(joined) ||
    block.length >= 2 ||
    /\b(road|street|st\.|nagar|sector|layout|plot|floor|flat|near|colony|phase)\b/i.test(joined)
  if (!ok) return undefined
  return joined
}

/**
 * Letterhead for Cache Digitech / Cache Technology on quotes and POs — must not be treated as the
 * customer's billing or shipping address when parsing a PO.
 */
export function isOurSellerPostalBlock(text: string): boolean {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (!t) return false
  if (/\bcache\s*digi\s*tech\b|\bcache\s*digitech\b|\bcache\s*technology\b/i.test(t)) {
    return true
  }
  const compact = t.replace(/\s/g, '')
  if (/\b07aaacc4248h1zu\b/i.test(compact) || /\baaacc\b/i.test(compact)) return true
  if (/\bkailash\s*colony\b/i.test(t)) return true
  // Branch letterhead (e.g. Sultanpur + Delhi PIN) seen in seller column in customer PO Excel.
  if (/\bsultanpur\b/i.test(t) && /\b(new\s*delhi|\bdelhi\b)/i.test(t) && /\b1100\d{2}\b/.test(t)) {
    return true
  }
  return false
}

/** Billing vs shipping mismatch typical of “seller column” + Mumbai buyer on Excel POs. */
function shippingLooksLikeSellerVersusBilling(
  billingAddress: string,
  shippingAddress: string,
  billingState: string,
  shippingState: string,
): boolean {
  const b = billingAddress.trim().toLowerCase()
  const s = shippingAddress.trim().toLowerCase()
  const bs = billingState.trim().toLowerCase()
  const ss = shippingState.trim().toLowerCase()

  const billingLooksMumbaiSide =
    /\bmaharashtra\b|\bmumbai\b|\bbirla\b|\bworli\b|\blower\s*parel\b|\bmah\b/i.test(b) ||
    bs.includes('maharashtra')

  const shipShortDelhiOfficePin =
    s.length < 140 &&
    /\b110048\b/.test(s) &&
    /new\s*delhi|\bdelhi\b/i.test(s) &&
    !/vodafone|idea\b/i.test(s)

  const shipStateDelhiOnly = ss === 'delhi' || ss === 'dl'

  return Boolean(
    billingLooksMumbaiSide &&
      (shipShortDelhiOfficePin || (shipStateDelhiOnly && s.length < 140 && !/vodafone|idea\b/i.test(s))),
  )
}

/**
 * Fix customer shipping persisted from older extraction (seller letterhead in “shipping”) and
 * align empty shipping with billing when the PO does not define ship-to separately.
 */
export function reconcileCustomerPartyAddressesForPersistedOvf(
  fields: OvfFormFields,
): OvfFormFields {
  const o = { ...fields }
  const bill = o.billingAddress.trim()
  const ship = o.shippingAddress.trim()
  if (!bill) return o

  const sellerLeak =
    (ship && isOurSellerPostalBlock(ship)) ||
    (ship &&
      bill &&
      shippingLooksLikeSellerVersusBilling(bill, ship, o.billingState, o.shippingState))

  const shipUnset = !ship

  if (sellerLeak || shipUnset) {
    o.shippingAddress = o.billingAddress
    if (o.billingState.trim()) o.shippingState = o.billingState
    return o
  }

  // If both addresses are identical, ensure state mirrors too.
  if (ship && bill && ship === bill && o.billingState.trim() && !o.shippingState.trim()) {
    o.shippingState = o.billingState
  }
  return o
}

function sanitizeCustomerPartySellerLeakage(out: CustomerPartyHints): void {
  for (const k of ['customerName', 'billingAddress', 'shippingAddress'] as const) {
    const v = out[k]
    if (typeof v === 'string' && v.trim() && isOurSellerPostalBlock(v)) {
      delete out[k]
    }
  }
  const bill = out.billingAddress?.trim() ?? ''
  const ship = out.shippingAddress?.trim() ?? ''
  if (
    bill &&
    ship &&
    shippingLooksLikeSellerVersusBilling(
      bill,
      ship,
      out.billingState?.trim() ?? '',
      out.shippingState?.trim() ?? '',
    )
  ) {
    delete out.shippingAddress
    delete out.shippingState
  }
}

/** When the PO does not label Bill-to vs Ship-to, use the single customer address for both. */
function mirrorCustomerAddressesWhenUnlabeled(
  out: CustomerPartyHints,
  explicitBillBlock: boolean,
  explicitShipBlock: boolean,
): void {
  const bill = out.billingAddress?.trim()
  const ship = out.shippingAddress?.trim()

  if (!explicitShipBlock && bill && !ship) {
    out.shippingAddress = out.billingAddress
    if (out.billingState?.trim() && !out.shippingState?.trim()) {
      out.shippingState = out.billingState
    }
  }
  if (!explicitBillBlock && ship && !bill) {
    out.billingAddress = out.shippingAddress
    if (out.shippingState?.trim() && !out.billingState?.trim()) {
      out.billingState = out.shippingState
    }
  }
  // “Ship-to” matched but text was seller letterhead (stripped) — use billing only.
  if (explicitShipBlock && bill && !ship) {
    out.shippingAddress = out.billingAddress
    if (out.billingState?.trim() && !out.shippingState?.trim()) {
      out.shippingState = out.billingState
    }
  }
}

/** Placeholder tokens mis-read as addresses (e.g. “WFH” work-from-home lines). */
function isJunkAddressPlaceholder(line: string): boolean {
  const t = line.trim().toLowerCase()
  if (!t) return true
  if (t.length <= 12 && /^(wfh|na|n\/a|n\.a\.|same|same\s+as\s+above|tbd|none|—|-|\.{2,})$/i.test(t)) {
    return true
  }
  return false
}

function guessStateFromLines(lines: string[]): string {
  const blob = lines.join(' ')
  const states = [
    'Maharashtra',
    'Karnataka',
    'Gujarat',
    'Tamil Nadu',
    'Delhi',
    'Telangana',
    'West Bengal',
    'Uttar Pradesh',
    'Rajasthan',
    'Punjab',
    'Haryana',
    'Madhya Pradesh',
    'Kerala',
    'Andhra Pradesh',
  ]
  for (const s of states) {
    if (new RegExp(`\\b${s.replace(/\s+/g, '\\s+')}\\b`, 'i').test(blob)) return s
  }
  const m = blob.match(/\b([A-Z]{2})\s*[-:]?\s*\d{6}\b/)
  if (m?.[1] && m[1].length === 2) return m[1]
  return ''
}

/** Vendor/seller legal name in grid PO (top-right box) — skip when picking buyer Name (top-left). */
function looksLikeSupplierLegalNameForPoGrid(name: string): boolean {
  return /\b(cache|digitech|pvt\s*ltd|technologies|supplier|seller)\b/i.test(name.trim())
}

/**
 * Excel/grid POs: "Name", "Address", "PO Number" cells above the Commercial table (no Bill-to labels).
 */
function applyExcelLikePoHeaderBeforeCommercial(
  lines: string[],
  out: CustomerPartyHints,
): void {
  const commercialIdx = lines.findIndex((l) => /^commercial\b/i.test(l.trim()))
  const headerEnd = commercialIdx >= 0 ? commercialIdx : Math.min(lines.length, 55)
  const headerSlice = lines.slice(0, headerEnd)
  /**
   * Spreadsheet → text often flattens buyer (left) + seller (right) cells into one line.
   * Keep the left-most non-empty cell to avoid polluting buyer address with seller letterhead.
   */
  const buyerSideOfGridRow = (raw: string): string => {
    const s = raw.trim()
    if (!s) return ''
    // Most common: seller block is appended with only spaces between cells (no visible delimiter).
    // If our seller appears in the line, truncate everything to its left.
    const sellerIdx = s
      .toLowerCase()
      .search(/\bcache\s*digi\s*tech\b|\bcache\s*digitech\b|\bcache\s*technology\b/i)
    if (sellerIdx > 0) {
      const left = s.slice(0, sellerIdx).trim()
      if (left) return left
    }
    if (!s.includes('|')) return s
    const parts = s
      .split('|')
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (parts.length === 0) return s
    // Prefer the first part that is NOT obviously the seller.
    for (const p of parts) {
      if (!looksLikeSupplierLegalNameForPoGrid(p) && !isOurSellerPostalBlock(p)) {
        return p
      }
    }
    return parts[0] ?? s
  }

  // Grid-style POs often render the first row as:
  // "<Buyer name>    PO -12345    <Seller name>" (tabs/spaces/CSV commas).
  // If we don't see explicit "Name:" labels, infer buyer from that first header row.
  let inferredBuyerRowIdx = -1
  if (!out.customerName?.trim()) {
    for (let i = 0; i < Math.min(headerSlice.length, 10); i++) {
      const row = headerSlice[i]
      if (!/\bPO\b/i.test(row) && !/\bP\.?\s*O\.?\b/i.test(row)) continue
      // Normalize CSV-like separators into spaces.
      const norm = row.replace(/[,|]+/g, ' ').replace(/\s+/g, ' ').trim()
      const m = norm.match(/^(.*?)\s+\bP\.?\s*O\.?\s*[-–]?\s*\d+\b/i)
      const left = (m?.[1] ?? '').trim()
      if (
        left &&
        left.length >= 2 &&
        left.length < 180 &&
        !looksLikeSupplierLegalNameForPoGrid(left)
      ) {
        // Sometimes Excel → CSV flattens Name + Address into the same left segment.
        // If it looks address-like, split: first chunk is name, remainder is billing address.
        const looksAddr =
          left.length > 55 &&
          (/\b\d{6}\b/.test(left) ||
            /\b(floor|plot|road|rd\.?|street|st\.?|lane|nagar|mumbai|maharashtra|delhi|jaipur)\b/i.test(
              left,
            ))
        if (looksAddr) {
          // Prefer a comma split when present; else split at the first address-ish token.
          const parts = left.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean)
          if (parts.length >= 2) {
            out.customerName = parts[0].slice(0, 180)
            const addrLines = parts.slice(1).slice(0, 10)
            const joined = addrLines.join('\n').trim()
            if (joined.length >= 12 && !isOurSellerPostalBlock(joined)) {
              out.billingAddress = joined
              const st = guessStateFromLines(addrLines)
              if (st) out.billingState = st
            }
          } else {
            const addrCut = left.match(
              /^(.+?)\s+(B\s*Wing|Floor|Plot|Centurion|Century|Road|Rd\.?|Street|St\.?|Lane|Nagar|Mumbai|Maharashtra|Delhi|Jaipur)\b/i,
            )
            if (addrCut?.[1]) {
              out.customerName = addrCut[1].trim().slice(0, 180)
              const rest = left.slice(addrCut[1].length).trim()
              if (rest.length >= 12 && !isOurSellerPostalBlock(rest)) {
                out.billingAddress = rest
                const st = guessStateFromLines([rest])
                if (st) out.billingState = st
              }
            } else {
              out.customerName = left
            }
          }
        } else {
          out.customerName = left
        }
        inferredBuyerRowIdx = i
        break
      }
    }
  }

  // If we found a buyer name on the first row, the next few rows often contain the buyer address
  // (until Commercial / Terms). Capture a short block when it looks address-like.
  if (!out.billingAddress?.trim()) {
    const buyerName = out.customerName?.trim() ?? ''
    const startIdx =
      inferredBuyerRowIdx >= 0
        ? inferredBuyerRowIdx
        : buyerName
          ? headerSlice.findIndex((l) => {
              const t = l.trim()
              return t === buyerName || t.startsWith(buyerName)
            })
          : -1
    if (startIdx >= 0) {
      const addrLines: string[] = []
      for (let j = startIdx + 1; j < headerSlice.length; j++) {
        const raw = headerSlice[j].trim()
        if (!raw) break
        if (/^commercial\b/i.test(raw)) break
        if (/^terms\b/i.test(raw)) break
        if (/^(sr\.?\s*no|item|qty|unit|total)\b/i.test(raw)) break
        if (/\bPO\b/i.test(raw) && addrLines.length === 0) continue
        const L = buyerSideOfGridRow(raw)
        if (!L) continue
        if (isJunkAddressPlaceholder(L)) continue
        addrLines.push(L)
        if (addrLines.length >= 8) break
      }
      const looksAddressEnough = (arr: string[]) => {
        const joined = arr.join(' ').toLowerCase()
        if (arr.length >= 2) return true
        // One long line from sheet exports can still be a valid address.
        return (
          (joined.length >= 30 &&
            (/\b\d{6}\b/.test(joined) ||
              /\b(floor|plot|road|rd\.?|street|st\.?|lane|nagar|mumbai|maharashtra|delhi|gurugram|gurgaon|noida|sector|block|building|bldg|tower)\b/i.test(
                joined,
              ))) ||
          false
        )
      }

      if (addrLines.length >= 1 && looksAddressEnough(addrLines)) {
        const joined = addrLines.join('\n')
        // Never treat Cache / our seller block as buyer billing/shipping.
        if (!isOurSellerPostalBlock(joined)) {
          out.billingAddress = joined
          const st = guessStateFromLines(addrLines)
          if (st) out.billingState = st
        }
      }
    }
  }

  const names: string[] = []
  for (const l of headerSlice) {
    const m = l.match(/^name\s*[:\s]+\s*(.+)$/i)
    if (m?.[1]?.trim()) names.push(m[1].trim())
  }
  if (names.length >= 1) {
    let buyer = names[0]
    if (looksLikeSupplierLegalNameForPoGrid(buyer) && names.length >= 2) {
      buyer = names[1]
    }
    if (buyer.length > 2 && buyer.length < 180) {
      out.customerName = buyer
    }
  }

  for (let i = 0; i < headerSlice.length; i++) {
    const line = headerSlice[i]
    if (!/^address\s*[:\s]+/i.test(line)) continue
    const chunk: string[] = []
    const inline = buyerSideOfGridRow(line.replace(/^address\s*[:\s]+/i, '').trim())
    if (inline) chunk.push(inline)
    for (let j = i + 1; j < headerSlice.length; j++) {
      const raw = headerSlice[j]
      if (
        /^(name|address|po\s*number|commercial|terms|sr\.?\s*no|item|qty)\b/i.test(raw)
      ) {
        break
      }
      const L = buyerSideOfGridRow(raw)
      if (L.trim()) chunk.push(L.trim())
    }
    const joined = chunk.join('\n')
    if (joined.length > 12) {
      out.billingAddress = joined
      const st = guessStateFromLines(chunk)
      if (st) out.billingState = st
    }
    break
  }

  const headerBlob = headerSlice.join('\n')
  const poHdr = headerBlob.match(
    /\bPO\s*Number\s*[:\s]*\s*(PO\s*[-–]?\s*[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9\/\-]{1,40})/i,
  )
  if (poHdr?.[1]) {
    const cleaned = poHdr[1].replace(/\s+/g, ' ').trim()
    if (cleaned.length >= 2 && cleaned.length < 90) out.customerPoNumber = cleaned
  }
}

/**
 * Heuristic scan of customer PO text for Bill-to / Ship-to style blocks.
 */
export function parseCustomerPartyFromPoText(raw: string): CustomerPartyHints {
  const text = raw.replace(/\r\n/g, '\n')
  const full = text.replace(/\s+/g, ' ').trim()
  const out: CustomerPartyHints = {}

  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  applyExcelLikePoHeaderBeforeCommercial(lines, out)

  // Do not match lines that start with "Customer PO …" — those are PO metadata, not Bill-to blocks.
  const billLabel =
    /^(bill\s*to|billing\s*address|invoice\s*to|buyer'?s?\s*(?:name\s*&\s*)?address|customer(?!\s*po\b)|buyer|purchaser|consignor|order\s*placed\s*by|your\s*order|company\s*name|customer\s*details|name\s*&\s*address)\b/i

  const billLines = blockAfterLabel(lines, billLabel)
  const shipLines = blockAfterLabel(lines, /^(ship\s*to|deliver(?:y)?\s*to|consignee|dispatch\s*to)\b/i)
  const explicitBillBlock = billLines.length > 0
  const explicitShipBlock = shipLines.length > 0

  if (billLines.length) {
    const l1 = billLines[0]
    const l2 = billLines.length > 1 ? billLines[1] : ''
    const l1Org = looksLikeBuyerOrganizationName(l1)
    const l2Org = Boolean(l2 && looksLikeBuyerOrganizationName(l2))

    /** Address remainder after buyer identity line(s) */
    let restForAddr: string[]

    if (l1Org) {
      // PO shows company/trading first — authoritative org line.
      if (!out.customerName?.trim() && l1.length > 2 && l1.length < 160) out.customerName = l1
      restForAddr = billLines.slice(1).filter((l) => !isJunkAddressPlaceholder(l))
    } else if (l2Org) {
      // Person / informal label first line, company second — PO “original” is org.
      if (!out.contactPerson?.trim() && l1.length > 2 && l1.length < 160) out.contactPerson = l1
      const l2Trim = l2.trim()
      if (!out.customerName?.trim() && l2Trim.length > 2 && l2Trim.length < 160) {
        out.customerName = l2Trim
      }
      restForAddr = billLines.slice(2).filter((l) => !isJunkAddressPlaceholder(l))
    } else {
      // No recognizable org — treat first line as informal buyer “name”, not authoritative company.
      if (!out.contactPerson?.trim() && l1.length > 2 && l1.length < 160) out.contactPerson = l1
      restForAddr = billLines.slice(1).filter((l) => !isJunkAddressPlaceholder(l))
    }

    const addr = joinAddress(restForAddr)
    if (
      addr &&
      !isJunkAddressPlaceholder(addr.split('\n')[0] ?? '') &&
      !out.billingAddress?.trim()
    ) {
      out.billingAddress = addr
    }
    const st = guessStateFromLines(billLines)
    if (st && !out.billingState?.trim()) out.billingState = st
  }

  if (shipLines.length) {
    const addr = joinAddress(shipLines.filter((l) => !isJunkAddressPlaceholder(l)))
    if (
      addr &&
      !isJunkAddressPlaceholder(addr.split('\n')[0] ?? '') &&
      !out.shippingAddress?.trim()
    ) {
      out.shippingAddress = addr
    }
    const st = guessStateFromLines(shipLines)
    if (st && !out.shippingState?.trim()) out.shippingState = st
  }

  const commercialIdxForContact = lines.findIndex((l) =>
    /^commercial\b/i.test(l.trim()),
  )
  const headerOnlyText =
    commercialIdxForContact >= 0
      ? lines.slice(0, commercialIdxForContact).join('\n')
      : ''

  // Prefer Bill-to / Ship-to text; else header-only (grid PO) before Commercial / line items.
  const buyerTextForContact =
    billLines.length > 0
      ? billLines.join('\n')
      : shipLines.length > 0
        ? shipLines.join('\n')
        : headerOnlyText
  if (!out.contactNumber) {
    const scopedPick = buyerTextForContact ? pickFirstLikelyPhone(buyerTextForContact) : undefined
    const anyPick = pickFirstLikelyPhone(full)
    const picked = scopedPick ?? anyPick
    if (picked) out.contactNumber = picked
  }
  if (!out.contactEmail) {
    const scoped = buyerTextForContact.match(EMAIL_RE)
    const emails = scoped ?? full.match(EMAIL_RE)
    if (emails?.[0]) out.contactEmail = emails[0]
  }

  const netM = full.match(/\bNet\s*(\d{1,3})\s*(?:days?|D)\b/i)
  if (netM?.[1]) {
    out.customerPaymentTerms = `${netM[1]} days`
  } else {
    const payTermsLine = full.match(
      /\bPayment\s*terms\s*[:\s]*(\d{1,3})\s*days?\b/i,
    )
    if (payTermsLine?.[1]) {
      out.customerPaymentTerms = `${payTermsLine[1]} days`
    } else {
      const pt = full.match(
        /\b(?:payment\s*terms?|payment\s*condition)\s*[:\s]*([^\n]{3,80})/i,
      )
      if (pt?.[1]) {
        const t = cleanLine(pt[1]).slice(0, 90)
        if (t.length >= 2) out.customerPaymentTerms = t
      }
    }
  }

  if (out.customerPaymentTerms) {
    const norm = normalizeExtractedPaymentTermsForOvf(out.customerPaymentTerms)
    if (norm) out.customerPaymentTerms = norm
  }

  const poRef = extractPoNumberFromPlainText(text)
  if (poRef) out.customerPoNumber = poRef

  sanitizeCustomerPartySellerLeakage(out)
  mirrorCustomerAddressesWhenUnlabeled(out, explicitBillBlock, explicitShipBlock)

  return out
}

export function mergeVendorPartyHintsIntoFields(
  base: OvfFormFields,
  hints: VendorPartyHints,
): OvfFormFields {
  return mergeVendor(base, hints)
}

export function mergeCustomerPartyHintsIntoFields(
  base: OvfFormFields,
  hints: CustomerPartyHints,
): OvfFormFields {
  return mergeCustomer(base, hints)
}

function mergeVendor(f: OvfFormFields, h: VendorPartyHints): OvfFormFields {
  const o = { ...f }
  if (h.vendorName?.trim()) o.vendorName = h.vendorName.trim()
  if (h.vendorAddressDetail?.trim()) {
    const next = h.vendorAddressDetail.trim()
    const cur = o.vendorAddressDetail.trim()
    if (!cur || next.length > cur.length) o.vendorAddressDetail = next
  }
  if (h.vendorPoNumber?.trim()) o.vendorPoNumber = h.vendorPoNumber.trim()
  if (h.vendorContactNumber?.trim()) o.vendorContactNumber = h.vendorContactNumber.trim()
  if (h.vendorEmailId?.trim()) o.vendorEmailId = h.vendorEmailId.trim()
  if (h.vendorPaymentTerms?.trim()) o.vendorPaymentTerms = h.vendorPaymentTerms.trim()
  return o
}

/** Any structured hint from the customer PO parse — prefer these over stale quote snapshot fields. */
function hasNonEmptyCustomerPartyHints(h: CustomerPartyHints): boolean {
  return Boolean(
    (h.customerName && h.customerName.trim()) ||
      (h.contactPerson && h.contactPerson.trim()) ||
      (h.customerPoNumber && h.customerPoNumber.trim()) ||
      (h.billingAddress && h.billingAddress.trim()) ||
      (h.shippingAddress && h.shippingAddress.trim()) ||
      (h.billingState && h.billingState.trim()) ||
      (h.shippingState && h.shippingState.trim()) ||
      (h.contactNumber && h.contactNumber.trim()) ||
      (h.contactEmail && h.contactEmail.trim()) ||
      (h.customerPaymentTerms && h.customerPaymentTerms.trim()),
  )
}

function mergeCustomer(f: OvfFormFields, h: CustomerPartyHints): OvfFormFields {
  const o = { ...f }
  let poBill = h.billingAddress?.trim() ?? ''
  let poShip = h.shippingAddress?.trim() ?? ''
  if (poBill && isOurSellerPostalBlock(poBill)) poBill = ''
  if (poShip && isOurSellerPostalBlock(poShip)) poShip = ''
  const quoteBill = o.billingAddress.trim()
  const poRich =
    poBill.length > 40 ||
    poShip.length > 40 ||
    (poBill.length > 0 && poBill.split(/\n/).filter(Boolean).length >= 2)
  /** Prefer PO-derived party rows over quote prefill whenever the PO parser produced anything useful. */
  const preferPo = poRich || hasNonEmptyCustomerPartyHints(h)

  if (h.customerName?.trim()) {
    const incoming = h.customerName.trim()
    const cur = o.customerName.trim()
    if (!cur || preferPo) {
      if (cur && !o.contactPerson.trim() && preferPo && incoming !== cur) {
        o.contactPerson = cur
      }
      o.customerName = incoming
    }
  }
  if (h.contactPerson?.trim()) {
    if (!o.contactPerson.trim() || preferPo) o.contactPerson = h.contactPerson.trim()
  }
  if (poBill) {
    if (!quoteBill || preferPo || poBill.length > quoteBill.length) {
      o.billingAddress = poBill
    }
  }
  if (poShip) {
    const qShip = o.shippingAddress.trim()
    if (!qShip || preferPo || poShip.length > qShip.length) o.shippingAddress = poShip
  }
  if (h.billingState?.trim()) {
    if (!o.billingState.trim() || preferPo) o.billingState = h.billingState.trim()
  }
  if (h.shippingState?.trim()) {
    if (!o.shippingState.trim() || preferPo) o.shippingState = h.shippingState.trim()
  }
  if (h.contactNumber?.trim()) {
    if (!o.contactNumber.trim() || preferPo) o.contactNumber = h.contactNumber.trim()
  }
  if (h.contactEmail?.trim()) {
    if (!o.contactEmail.trim() || preferPo) o.contactEmail = h.contactEmail.trim()
  }
  if (h.customerPaymentTerms?.trim()) {
    if (!o.customerPaymentTerms.trim() || preferPo) {
      o.customerPaymentTerms = h.customerPaymentTerms.trim()
    }
  }
  if (h.customerPoNumber?.trim()) {
    if (!o.customerPoNumber.trim() || preferPo) {
      o.customerPoNumber = h.customerPoNumber.trim()
    }
  }
  return reconcileCustomerPartyAddressesForPersistedOvf(o)
}

function attachmentToFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
): File {
  return new File([blob], fileName || 'attachment', {
    type: mimeType || blob.type || 'application/octet-stream',
  })
}

/**
 * Vendor invoice for extraction: Finance handoff attachment, else a likely invoice among OVF proofs
 * (same file may be duplicated as proof when the quote record did not carry `vendorInvoice`).
 */
export function pickVendorInvoiceAttachment(
  record: SavedQuoteRecord,
): OvfProofAttachment | undefined {
  const primary = record.quoteFinanceReview?.vendorInvoice
  if (primary?.dataBase64) return primary

  const poData = record.po?.dataBase64?.trim()
  const proofs = record.ovf?.proofAttachments ?? []
  const candidates = proofs.filter((p) => {
    if (!p.dataBase64?.trim()) return false
    if (poData && p.dataBase64.trim() === poData) return false
    return true
  })
  if (candidates.length === 0) return undefined

  const scoreOf = (p: OvfProofAttachment): number => {
    const name = (p.fileName || '').toLowerCase()
    const mime = (p.mimeType || '').toLowerCase()
    let s = 0
    if (/invoice|vendor|supplier|seller|purchase|bill|commercial|tax/i.test(name)) s += 12
    if (mime.includes('pdf')) s += 3
    if (mime.includes('sheet') || /\.xlsx?$/i.test(name) || /\.csv$/i.test(name)) {
      s += 2
    }
    return s
  }

  return [...candidates].sort((a, b) => scoreOf(b) - scoreOf(a))[0]
}

/**
 * Best-effort: read vendor invoice + customer PO files and merge party hints into OVF prefill.
 * Safe to call when attachments are missing (no-op).
 */
export async function enrichOvfPrefillFromAttachments(
  base: OvfFormFields,
  record: SavedQuoteRecord,
): Promise<OvfFormFields> {
  let next = { ...base }

  const vi = pickVendorInvoiceAttachment(record)
  if (vi?.dataBase64) {
    try {
      const blob = await proofAttachmentBlobAsync(vi)
      const file = attachmentToFile(blob, vi.fileName || 'invoice', vi.mimeType || blob.type)
      const text = await extractInvoiceRawTextForFooterScan(file)
      if (text.trim().length > 20) {
        next = mergeVendor(next, parseVendorPartyFromInvoiceText(text))
      }
    } catch {
      /* keep base */
    }
  }

  if (record.po?.dataBase64) {
    try {
      const blob = quotePoBlob(record.po)
      const file = attachmentToFile(
        blob,
        record.po.fileName || 'po',
        record.po.mimeType || blob.type,
      )
      const text = await extractPoRawTextForPartyScan(file)
      if (text.trim().length > 20) {
        next = mergeCustomer(next, parseCustomerPartyFromPoText(text))
      }
    } catch {
      /* keep next */
    }
  }

  if (!next.vendorPaymentTerms?.trim()) {
    next.vendorPaymentTerms = OVF_DEFAULT_VENDOR_PAYMENT_TERMS
  }

  return next
}
