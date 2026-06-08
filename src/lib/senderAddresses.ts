import type { SenderAddressPreset } from '../types/quotePdf'

export function formatQuoteDateDisplay(iso: string): string {
  const parts = iso.trim().split('-')
  if (parts.length === 3) {
    const [y, m, d] = parts
    if (y && m && d) return `${d}/${m}/${y}`
  }
  return iso.trim() || '—'
}

export type SenderHeaderLine = {
  text: string
  blue?: boolean
  bold?: boolean
}

export type SenderPdfContent = {
  headerLines: SenderHeaderLine[]
  footerCompany: string
  footerRegisteredLine: string
  footerContactLine: string
}

/**
 * Sender letterhead split for OVF: one field each for address, GST, and quote number
 * (instead of a single combined block).
 */
export function getSenderOvfSplit(
  preset: SenderAddressPreset,
  quoteDateIso: string,
  quoteRef: string,
  validUntilIso: string,
): { address: string; gst: string; quoteNo: string } {
  const sender = getSenderPdfContent(
    preset,
    quoteDateIso,
    quoteRef,
    validUntilIso,
  )
  const ref = quoteRef.trim() || '—'

  const gstLine =
    sender.headerLines
      .map((l) => l.text.trim())
      .find((t) => t.toUpperCase().startsWith('GST')) ?? '—'

  const lines = sender.headerLines.map((l) => l.text.trim())
  const addrParts: string[] = []
  for (const t of lines) {
    const u = t.toUpperCase()
    if (
      u.startsWith('TEL') ||
      u.startsWith('GST:') ||
      u.startsWith('DATE:') ||
      u.startsWith('QUOTE NO') ||
      u.startsWith('VALID UNTIL')
    ) {
      break
    }
    addrParts.push(t)
  }
  let address = addrParts.join('\n')
  if (sender.footerRegisteredLine.trim()) {
    address = [address, sender.footerRegisteredLine.trim()]
      .filter(Boolean)
      .join('\n')
  }
  if (!address.trim()) {
    address = lines.join('\n')
  }

  return {
    address: address.trim() || '—',
    gst: gstLine,
    quoteNo: ref,
  }
}

export function getSenderPdfContent(
  preset: SenderAddressPreset,
  quoteDateIso: string,
  quoteRef: string,
  validUntilIso: string,
): SenderPdfContent {
  const d = formatQuoteDateDisplay(quoteDateIso)
  const v = formatQuoteDateDisplay(validUntilIso)
  const ref = quoteRef.trim() || '—'

  if (preset === 'secondary') {
    return {
      headerLines: [
        { text: 'xyz', blue: true, bold: true },
        { text: 'xyz', bold: true },
        { text: 'xyz', bold: true },
        { text: 'xyz', bold: true },
        { text: `Date: ${d}`, bold: true },
        { text: `Quote No.: ${ref}`, bold: true },
        { text: `Valid until: ${v}`, bold: true },
      ],
      footerCompany: 'xyz',
      footerRegisteredLine: 'xyz',
      footerContactLine: 'xyz',
    }
  }

  return {
    headerLines: [
      { text: 'CACHE DIGITECH PVT LTD', blue: true, bold: true },
      { text: 'L-31 Ground Floor, Kailash Colony,', bold: true },
      { text: 'New Delhi,', bold: true },
      { text: 'Delhi-110048', bold: true },
      { text: 'India', bold: true },
      { text: 'Tel.: 011-47105700-25', bold: true },
      { text: 'GST: 07AAACC4248H1ZU', bold: true },
      { text: `Date: ${d}`, bold: true },
      { text: `Quote No.: ${ref}`, bold: true },
      { text: `Valid until: ${v}`, bold: true },
    ],
    footerCompany: 'CACHE DIGITECH PVT LTD',
    footerRegisteredLine:
      'Registered Office: L-31 Ground Floor, Kailash Colony, New Delhi, Delhi-110048, India',
    footerContactLine:
      'Tel: 011-47105700-25. E-mail : info@cachedigitech.com, Web. : www.cachedigitech.com',
  }
}
