/** Indian English wording for rupee amounts (PO / invoice style). */

const UNITS = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const

function wordsBelow100(n: number): string {
  if (n < 20) return UNITS[n] || ''
  const t = Math.floor(n / 10)
  const u = n % 10
  const ten = TENS[t] || ''
  return u ? `${ten} ${UNITS[u]}`.trim() : ten
}

function wordsBelow1000(n: number): string {
  if (n === 0) return ''
  if (n < 100) return wordsBelow100(n)
  const h = Math.floor(n / 100)
  const rest = n % 100
  const head = `${UNITS[h]} Hundred`
  return rest ? `${head} ${wordsBelow100(rest)}`.trim() : head
}

/** Converts a non‑negative integer rupee amount to words (Indian grouping). */
export function rupeesIntegerToWords(num: number): string {
  const n = Math.floor(Math.abs(num))
  if (n === 0) return 'Zero'

  const crore = Math.floor(n / 10000000)
  let rest = n % 10000000
  const lakh = Math.floor(rest / 100000)
  rest %= 100000
  const thousand = Math.floor(rest / 1000)
  rest %= 1000

  const parts: string[] = []
  if (crore) parts.push(`${wordsBelow100(crore)} Crore`.trim())
  if (lakh) parts.push(`${wordsBelow100(lakh)} Lakh`.trim())
  if (thousand) parts.push(`${wordsBelow1000(thousand)} Thousand`.trim())
  if (rest) parts.push(wordsBelow1000(rest))

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** e.g. "Indian Rupee Eleven Thousand Thirty-Three Only" */
export function formatInrAmountWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return 'Indian Rupee Zero Only'
  }
  const rupees = Math.floor(amount + 1e-9)
  const paise = Math.round((amount - rupees) * 100)

  let body = rupeesIntegerToWords(rupees)
  if (paise > 0) {
    const pWords = rupeesIntegerToWords(paise)
    body = `${body} and ${pWords} Paise`
  }

  return `Indian Rupee ${body} Only`
}
