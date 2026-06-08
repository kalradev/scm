import type { OvfFormFields } from '../types/ovf'

const BODY_MAX = 2200

function line(label: string, value: string): string {
  const v = value.trim()
  return `${label}: ${v || '—'}`
}

/** Plain-text summary for finance (mailto body). Kept short for client URL limits. */
export function buildFinanceEmailPlainBody(
  ovfRef: string,
  quoteRef: string,
  fields: OvfFormFields,
): string {
  const parts = [
    `OVF: ${ovfRef}`,
    line('Company PO number', fields.companyPoNumber),
    `Quote: ${quoteRef}`,
    '',
    line('Customer', fields.customerName),
    line('Vendor', fields.vendorName),
    line('Vendor address', fields.vendorAddressDetail),
    line('Customer PO number', fields.customerPoNumber),
    line('Margin (total)', fields.margin),
    line('Margin %', fields.marginPercent),
    '',
    'Tip: Attach the OVF HTML file from “Download OVF (HTML)” in the app for the full layout.',
  ]
  let body = parts.join('\n')
  if (body.length > BODY_MAX) {
    body = `${body.slice(0, BODY_MAX - 20)}\n…(truncated)`
  }
  return body
}

export function buildFinanceEmailSubject(ovfRef: string, quoteRef: string): string {
  return `OVF ${ovfRef} — Quote ${quoteRef || '—'}`
}

export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}

export function openFinanceMailto(
  financeEmail: string,
  subject: string,
  body: string,
): void {
  const to = financeEmail.trim()
  const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
