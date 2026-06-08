/**
 * OpenAI Chat Completions for OVF customer / vendor party field extraction.
 * Called only from the API server; use OPENAI_API_KEY in .env (never VITE_*).
 */

const MAX_DOC_CHARS = 100_000
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

function strField(v: unknown, max: number): string {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/\r\n/g, '\n').trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) : s
}

function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim())
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

async function callOpenAiJson(system: string, user: string): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new Error('openai_unconfigured')
  }
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini'
  const body = {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
  }
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    const err = new Error(`openai_http_${res.status}`)
    ;(err as Error & { body?: string }).body = t.slice(0, 500)
    throw err
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('openai_empty_content')
  }
  return JSON.parse(content) as unknown
}

const CUSTOMER_SYSTEM = `You extract structured data from a customer purchase order or similar document (plain text).
Return ONLY a JSON object with these exact keys (use empty string "" if unknown or not present):
{
  "customerName": "",
  "contactPerson": "",
  "customerPoNumber": "",
  "billingAddress": "",
  "shippingAddress": "",
  "billingState": "",
  "shippingState": "",
  "contactNumber": "",
  "contactEmail": "",
  "customerPaymentTerms": ""
}
Rules:
- customerName: ONLY when the PO clearly shows a BUYER ORGANIZATION (legal/trading/company line — Bill-to, Buyer, Company name). Copy spelling exactly — treat as authoritative (“original” from the PO). If the PO does not show any distinct company/legal buyer, leave this as "" (do not put a lone informal person name here).
- contactPerson: individual addressee (Attention / Kind attn / contact / ordered-by). When BOTH a buyer company and a separate person appear: organization → customerName, person → contactPerson. When the PO has NO company line and only an informal buyer name, put that name ONLY in contactPerson; leave customerName as "" (quotes may still carry an informal company line off-document — do not invent one from the PO).
- customerPoNumber: the customer's PO reference (labels like Customer PO, PO No, Order No).
- billingAddress: BUYER postal/location lines from Bill-to / billing / invoice-to (NOT the seller). Copy line breaks and wording from the PO when they appear — authoritative “original”. Omit buyer company/contact name lines already captured elsewhere; streets, city, state, postal code only. Multi-line joined with newline. If the PO prints no usable billing location, use "" — do not guess from unrelated text.
- shippingAddress: BUYER Ship-to / delivery / consignee address when labeled separately; same rules — exact from PO when present, newline-separated, otherwise "" — do not fabricate or duplicate billing unless Ship-to explicitly matches.
- billingState / shippingState: Indian state name OR 2-letter US state if clear; else "".
- contactNumber / contactEmail: buyer contact when labeled as such; prefer Bill-to / buyer block over seller.
- customerPaymentTerms: normalize to one of "15 days", "30 days", "45 days", "60 days" when payment is net days; otherwise a short phrase under 80 chars.
Do not invent values; use "" when unsure.`

const VENDOR_SYSTEM = `You extract structured data from a vendor invoice, supplier bill, or similar document (plain text).
Return ONLY a JSON object with these exact keys (use empty string "" if unknown or not present):
{
  "vendorName": "",
  "vendorPoNumber": "",
  "vendorContactNumber": "",
  "vendorEmailId": "",
  "vendorPaymentTerms": ""
}
Rules:
- vendorName: supplier/seller LEGAL or trading COMPANY name only — the organization that issued the invoice (not the buyer). NEVER put section headings here such as "Contact", "Address", "Phone", "Email", "Supplier", "Details" — those label a block; the real name is usually on the line immediately AFTER such a heading (e.g. below "Contact"). If you only see a heading and no company name, use "".
- vendorPoNumber: supplier invoice number / tax invoice number / bill number (NOT the customer's PO unless it is clearly the supplier's own reference).
- vendorContactNumber / vendorEmailId: from seller/supplier section.
- vendorPaymentTerms: normalize to "15 days", "30 days", "45 days", "60 days" when net days apply; else short phrase under 80 chars.
Do not invent values; use "" when unsure.`

export type CustomerPartyExtractJson = {
  customerName: string
  contactPerson: string
  customerPoNumber: string
  billingAddress: string
  shippingAddress: string
  billingState: string
  shippingState: string
  contactNumber: string
  contactEmail: string
  customerPaymentTerms: string
}

export type VendorPartyExtractJson = {
  vendorName: string
  vendorPoNumber: string
  vendorContactNumber: string
  vendorEmailId: string
  vendorPaymentTerms: string
}

export function openaiPartyExtractAvailable(): boolean {
  return isOpenAiConfigured()
}

export async function extractCustomerPartyWithOpenAI(
  documentText: string,
): Promise<CustomerPartyExtractJson> {
  const text = documentText.slice(0, MAX_DOC_CHARS)
  const raw = await callOpenAiJson(
    CUSTOMER_SYSTEM,
    `Document text:\n\n${text}`,
  ) as Record<string, unknown>

  return {
    customerName: strField(raw.customerName, 200),
    contactPerson: strField(raw.contactPerson, 200),
    customerPoNumber: strField(raw.customerPoNumber, 80),
    billingAddress: strField(raw.billingAddress, 2000),
    shippingAddress: strField(raw.shippingAddress, 2000),
    billingState: strField(raw.billingState, 80),
    shippingState: strField(raw.shippingState, 80),
    contactNumber: strField(raw.contactNumber, 60),
    contactEmail: strField(raw.contactEmail, 120),
    customerPaymentTerms: strField(raw.customerPaymentTerms, 120),
  }
}

function sanitizeVendorNameFromModel(raw: unknown): string {
  const s = strField(raw, 200)
  if (!s) return ''
  const t = s.trim()
  if (
    t.length <= 48 &&
    /^(contact|attention|address|phone|telephone|tel|mobile|email|e-?mail|fax|details?|office|location|vendor|supplier|sold\s*by|from)$/i.test(
      t,
    )
  ) {
    return ''
  }
  if (/\b(?:tax|gst|cgst|sgst|igst|vat|cess)\s*\(/i.test(t)) return ''
  if (/\b(?:sub\s*total|grand\s*total|net\s*(?:amount|payable)|balance\s*due)\b/i.test(t)) {
    return ''
  }
  if (/\d{1,3}\s*%/.test(t) && /[\d,]{3,}/.test(t.replace(/\s/g, ''))) return ''
  return s
}

export async function extractVendorPartyWithOpenAI(
  documentText: string,
): Promise<VendorPartyExtractJson> {
  const text = documentText.slice(0, MAX_DOC_CHARS)
  const raw = await callOpenAiJson(
    VENDOR_SYSTEM,
    `Document text:\n\n${text}`,
  ) as Record<string, unknown>

  return {
    vendorName: sanitizeVendorNameFromModel(raw.vendorName),
    vendorPoNumber: strField(raw.vendorPoNumber, 80),
    vendorContactNumber: strField(raw.vendorContactNumber, 60),
    vendorEmailId: strField(raw.vendorEmailId, 120),
    vendorPaymentTerms: strField(raw.vendorPaymentTerms, 120),
  }
}
