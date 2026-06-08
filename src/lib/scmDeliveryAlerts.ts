import { listSavedQuotesWithScmPo } from './savedQuotesStorage'

export type ScmDeliveryAlert = {
  quoteId: string
  poRef: string
  customerName: string
  deliveryDate: string
  daysUntil: number
}

function parseIsoDateLocal(iso: string): Date | null {
  const t = String(iso ?? '').trim()
  if (!t) return null
  const d = new Date(t + (t.length <= 10 ? 'T12:00:00' : ''))
  return Number.isNaN(d.getTime()) ? null : d
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * POs whose delivery date is within `withinDays` (inclusive of today).
 * `daysUntil` is 0 = due today, negative = overdue.
 */
export function listScmPoDeliveryAlerts(withinDays: number): ScmDeliveryAlert[] {
  const today = startOfDay(new Date())
  const out: ScmDeliveryAlert[] = []
  const cap = Math.max(0, withinDays)

  for (const r of listSavedQuotesWithScmPo()) {
    const p = r.scmPo
    if (!p || p.status !== 'final') continue
    if (!p.deliveryDate?.trim()) continue
    const dd = parseIsoDateLocal(p.deliveryDate)
    if (!dd) continue
    const diff = Math.round(
      (startOfDay(dd).getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
    )
    if (diff <= cap) {
      out.push({
        quoteId: r.id,
        poRef: p.poRef || '—',
        customerName: (p.customerName || '').trim() || '—',
        deliveryDate: p.deliveryDate,
        daysUntil: diff,
      })
    }
  }

  out.sort((a, b) => a.daysUntil - b.daysUntil)
  return out
}
