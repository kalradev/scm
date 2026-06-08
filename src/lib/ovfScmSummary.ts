import { filterCommercialLines } from './quoteLineItems'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import {
  computeOvfAggregateEconomics,
  getOvfMarginDisplayStrings,
  normalizeVendorPurchaseMap,
} from './ovfVendorEconomics'
import { extraChargeInrFromField } from './ovfExtraCharges'
import { effectiveOvfWorkflow } from './ovfWorkflow'
import { getVendorByIdGlobally, getVendorForUser } from './vendorsStorage'
import type { OvfFormFields } from '../types/ovf'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import type { QuoteFormData } from '../types/quotePdf'

/**
 * Vendor line for SCM lists: prefers typed OVF fields; if empty but a directory vendor
 * was chosen, resolves the name from the Sales user's vendor list (`record.savedBy`).
 */
function formatVendorForScm(record: SavedQuoteRecord, fields: OvfFormFields): string {
  const name = (fields.vendorName || '').trim()
  const addr = (fields.vendorAddressDetail || '').trim()
  const firstLine = addr.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  if (name && firstLine) return `${name} — ${firstLine}`
  if (name) return name
  if (firstLine) return firstLine

  const dirId = (fields.vendorDirectoryId || '').trim()
  if (dirId) {
    const dir =
      getVendorForUser(dirId, record.savedBy) ?? getVendorByIdGlobally(dirId)
    const dirName = (dir?.name || '').trim()
    let line = firstLine
    if (!line && dir) {
      const addrId = (fields.vendorAddressId || '').trim()
      const addrRow = addrId
        ? dir.addresses.find((a) => a.id === addrId)
        : dir.addresses[0]
      const raw = (addrRow?.lines || '').trim()
      line = raw.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
    }
    if (dirName && line) return `${dirName} — ${line}`
    if (dirName) return dirName
    if (line) return line
  }

  return '—'
}

export type OvfScmOverviewRow = {
  quoteId: string
  quoteRef: string
  ovfRef: string
  customerName: string
  workflowLabel: string
  approvedBy: string
  productLines: string[]
  vendorName: string
  sellAmount: string
  purchaseAmount: string
  marginAmount: string
  marginPercent: string
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function workflowLabel(status: ReturnType<typeof effectiveOvfWorkflow>): string {
  switch (status) {
    case 'sales_draft':
      return 'Sales draft'
    case 'pending_finance':
      return 'Pending finance'
    case 'finance_rejected':
      return 'Rejected (finance)'
    case 'finance_approved':
      return 'Approved'
    default:
      return status
  }
}

export function buildOvfScmOverviewRow(record: SavedQuoteRecord): OvfScmOverviewRow | null {
  const ovf = record.ovf
  if (!ovf) return null
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(data.lineItems)
  const vendorMap = normalizeVendorPurchaseMap(ovf.fields)
  const agg = computeOvfAggregateEconomics(commercial, vendorMap)
  const freightInr = extraChargeInrFromField(
    ovf.fields.freightCharges,
    ovf.fields.freightChargesUnit,
    agg.totalPurchase,
  )
  const financeInr = extraChargeInrFromField(
    ovf.fields.financeCost,
    ovf.fields.financeCostUnit,
    agg.totalPurchase,
  )
  const sellAmount = formatInr(agg.totalSell)
  const purchaseAmount = formatInr(agg.totalPurchase + freightInr + financeInr)
  const margin = getOvfMarginDisplayStrings(
    ovf.fields,
    commercial,
    agg,
    freightInr + financeInr,
  )
  const wf = effectiveOvfWorkflow(ovf)
  const productLines = commercial.map((ln, i) => {
    const p = (ln.product || '').trim() || `Line ${i + 1}`
    const d = ln.description.trim()
    return d ? `${p} — ${d}` : p
  })
  return {
    quoteId: record.id,
    quoteRef: record.quoteRef || data.quoteRef || '—',
    ovfRef: ovf.ovfRef,
    customerName: (ovf.fields.customerName || data.customerName || '').trim() || '—',
    workflowLabel: workflowLabel(wf),
    approvedBy: (ovf.financeApprovedBy || '').trim() || '—',
    productLines: productLines.length ? productLines : [ovf.fields.productName.trim() || '—'],
    vendorName: formatVendorForScm(record, ovf.fields),
    sellAmount,
    purchaseAmount,
    marginAmount: margin.margin,
    marginPercent: margin.marginPercent,
  }
}
