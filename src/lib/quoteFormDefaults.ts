import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'

/** Long date for default terms text (e.g. 15 April 2026). */
export function formatDateForTerms(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`)
  if (Number.isNaN(d.getTime())) return isoDate || '—'
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export function defaultTermsAndConditions(validUntilIso: string): string {
  const priceUntil = formatDateForTerms(validUntilIso)
  return [
    '1. Order once placed is non-cancellable & non-transferable.',
    '2. Payment terms: 30 days from the date of invoice.',
    '3. Taxes will be applicable as per actuals.',
    `4. Price Validity: ${priceUntil}.`,
    '5. Standard Delivery timeline of 1-4 working days from the date of PO.',
    '6. The order will be placed at:',
    'CACHE DIGITECH PVT LTD',
    'L-31 Ground Floor, Kailash Colony,',
    'New Delhi,',
    'Delhi-110048',
    'India',
  ].join('\n')
}

export function defaultQuoteIntro(): string {
  return [
    'We are thankful for the enquiry. As desired, please find below our offer along with terms and conditions associated with the sale.',
    '',
    'Kindly refer the commercials as below.',
  ].join('\n')
}

export function defaultQuoteClosing(): string {
  return (
    'Hope you find our quotation in line with the requirement and place your valued order with us. ' +
    'If you need any clarification/information, please feel free to contact the undersigned.'
  )
}

/** Empty inputs when qty/unit price are numerically zero (legacy defaults used "0"). */
function blankIfNumericZero(raw: string | undefined): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  const n = Number.parseFloat(trimmed.replace(/,/g, ''))
  if (Number.isFinite(n) && n === 0) return ''
  return trimmed
}

/**
 * Merges legacy `customerTitle` into `customerName` when loading old saved quotes.
 * Line qty / unit price that are only "0" become blank for editing.
 */
export function normalizeQuoteFormData(
  input: QuoteFormData & { customerTitle?: string },
): QuoteFormData {
  const { customerTitle, ...rest } = input as QuoteFormData & {
    customerTitle?: string
  }
  const t = String(customerTitle ?? '').trim()
  const n = String(rest.customerName ?? '').trim()
  const customerName = t && n ? `${t} ${n}`.trim() : n || t
  const customerCompanyName = String(rest.customerCompanyName ?? '').trim()
  const lineItems = rest.lineItems?.map((ln) => ({
    ...ln,
    qty: blankIfNumericZero(ln.qty),
    unitPrice: blankIfNumericZero(ln.unitPrice),
    ...(ln.vendorUnitPrice !== undefined
      ? { vendorUnitPrice: blankIfNumericZero(ln.vendorUnitPrice) }
      : {}),
  }))
  return { ...rest, customerName, customerCompanyName, lineItems }
}

export function createEmptyLine(): QuoteLineForm {
  return {
    id: crypto.randomUUID(),
    product: '',
    description: '',
    qty: '',
    unitPrice: '',
  }
}

export function createInitialQuoteForm(): QuoteFormData {
  const today = new Date().toISOString().slice(0, 10)
  const valid = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
  return {
    senderAddressPreset: 'primary',
    quoteRef: '',
    quoteDate: today,
    validUntil: valid,
    customerName: '',
    customerCompanyName: '',
    customerAddress: '',
    subject: '',
    quoteSalutation: 'Dear Sir,',
    quoteIntro: defaultQuoteIntro(),
    quoteClosing: defaultQuoteClosing(),
    termsAndConditions: defaultTermsAndConditions(valid),
    signatoryName: '',
    lineItems: [
      createEmptyLine(),
      createEmptyLine(),
      createEmptyLine(),
    ],
  }
}
