import { listAllSavedQuoteRecords, type SavedQuoteRecord } from './savedQuotesStorage'

/**
 * India financial year Apr–Mar as `YY-YY` (e.g. Apr 2025–Mar 2026 → `25-26`).
 * Used for internal company PO refs like `PO/25-26/001`.
 */
export function companyPoFiscalYearLabel(d = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth()
  const startYear = m >= 3 ? y : y - 1
  const yy1 = String(startYear).slice(-2)
  const yy2 = String(startYear + 1).slice(-2)
  return `${yy1}-${yy2}`
}

export type CompanyPoPrefix = 'CT' | 'CDT'

const COMPANY_PO_RE = /^(?:(CT|CDT)\/)?PO\/(\d{2}-\d{2})\/(\d+)$/i

export function parseCompanyPoParts(
  raw: string | undefined | null,
): { prefix: CompanyPoPrefix | ''; fy: string; seq: number } | null {
  const t = String(raw ?? '').trim()
  const m = t.match(COMPANY_PO_RE)
  if (!m) return null
  const prefix = (String(m[1] ?? '').toUpperCase() as CompanyPoPrefix) || ''
  const seq = parseInt(m[3], 10)
  if (!Number.isFinite(seq)) return null
  return { prefix, fy: m[2], seq }
}

function companyPoNumberStringsOnRecord(r: SavedQuoteRecord): string[] {
  const fromOvf = String(r.ovf?.fields?.companyPoNumber ?? '').trim()
  const fromScm = String(r.scmPo?.companyPoNumber ?? '').trim()
  const out: string[] = []
  if (fromOvf) out.push(fromOvf)
  if (fromScm && fromScm !== fromOvf) out.push(fromScm)
  return out
}

/** Next sequential company PO for the fiscal year of `asOf` (all saved quotes: OVF + SCM PO). */
export function allocateNextCompanyPoNumber(
  prefix: CompanyPoPrefix | '' = '',
  asOf = new Date(),
): string {
  const fy = companyPoFiscalYearLabel(asOf)
  let maxSeq = 0
  for (const r of listAllSavedQuoteRecords()) {
    for (const v of companyPoNumberStringsOnRecord(r)) {
      const p = parseCompanyPoParts(v)
      if (!p || p.fy !== fy) continue
      if ((p.prefix || '') !== (prefix || '')) continue
      maxSeq = Math.max(maxSeq, p.seq)
    }
  }
  const next = maxSeq + 1
  const base = `PO/${fy}/${String(next).padStart(3, '0')}`
  return prefix ? `${prefix}/${base}` : base
}
