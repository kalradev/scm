import type { QuoteFormData } from '../types/quotePdf'
import type { Role } from '../types/roles'
import type { SavedQuoteRecord } from './savedQuotesStorage'
import { isQuoteDraft } from './savedQuotesStorage'
import { effectiveOvfWorkflow } from './ovfWorkflow'
import { getQuoteMoneySummary } from './quotePdfTemplate'
import { normalizeQuoteFormData } from './quoteFormDefaults'
import { poMatchLabel } from './quotePoMatch'

export type PipelineStageId =
  | 'sales_quote_draft'
  | 'sales_no_ovf'
  | 'sales_ovf_draft'
  | 'finance_review'
  | 'finance_rejected'
  | 'scm_ready'
  | 'scm_po_draft'
  | 'scm_po_final'

export const PIPELINE_STAGES: readonly PipelineStageId[] = [
  'sales_quote_draft',
  'sales_no_ovf',
  'sales_ovf_draft',
  'finance_review',
  'finance_rejected',
  'scm_ready',
  'scm_po_draft',
  'scm_po_final',
] as const

const STAGE_COPY: Record<
  PipelineStageId,
  { label: string; owner: Role; short: string }
> = {
  sales_quote_draft: { label: 'Quote draft', owner: 'sales', short: 'Draft' },
  sales_no_ovf: { label: 'Final quote, no OVF', owner: 'sales', short: 'No OVF' },
  sales_ovf_draft: { label: 'OVF in progress', owner: 'sales', short: 'OVF draft' },
  finance_review: { label: 'Pending approval', owner: 'finance', short: 'In queue' },
  finance_rejected: { label: 'Rejected to Sales', owner: 'finance', short: 'Rejected' },
  scm_ready: { label: 'Approved — no PO', owner: 'scm', short: 'Awaiting PO' },
  scm_po_draft: { label: 'PO draft', owner: 'scm', short: 'PO draft' },
  scm_po_final: { label: 'PO final', owner: 'scm', short: 'PO final' },
}

export function getStageInfo(id: PipelineStageId) {
  return STAGE_COPY[id]
}

export function activityMs(r: SavedQuoteRecord): number {
  if (r.scmPo) {
    const t = (r.scmPo as { updatedAt?: string }).updatedAt
    if (t) {
      const n = new Date(t).getTime()
      if (Number.isFinite(n)) return n
    }
  }
  if (r.ovf?.updatedAt) {
    const n = new Date(r.ovf.updatedAt).getTime()
    if (Number.isFinite(n)) return n
  }
  if (r.po?.uploadedAt) {
    const n = new Date(r.po.uploadedAt).getTime()
    if (Number.isFinite(n)) return n
  }
  return new Date(r.savedAt).getTime()
}

export function classifyRecordStage(
  r: SavedQuoteRecord,
): { id: PipelineStageId; linkTo: 'sales' | 'finance' | 'scm' | null; quoteId: string } {
  if (isQuoteDraft(r)) {
    return { id: 'sales_quote_draft', linkTo: 'sales', quoteId: r.id }
  }
  if (!r.ovf) {
    return { id: 'sales_no_ovf', linkTo: 'sales', quoteId: r.id }
  }
  const w = effectiveOvfWorkflow(r.ovf)
  if (w === 'sales_draft') {
    return { id: 'sales_ovf_draft', linkTo: 'sales', quoteId: r.id }
  }
  if (w === 'pending_finance') {
    return { id: 'finance_review', linkTo: 'finance', quoteId: r.id }
  }
  if (w === 'finance_rejected') {
    return { id: 'finance_rejected', linkTo: 'sales', quoteId: r.id }
  }
  if (w === 'finance_approved') {
    if (!r.scmPo) {
      return { id: 'scm_ready', linkTo: 'scm', quoteId: r.id }
    }
    if (r.scmPo.status === 'final') {
      return { id: 'scm_po_final', linkTo: 'scm', quoteId: r.id }
    }
    return { id: 'scm_po_draft', linkTo: 'scm', quoteId: r.id }
  }
  return { id: 'sales_ovf_draft', linkTo: 'sales', quoteId: r.id }
}

export function adminLinkForRow(
  linkTo: 'sales' | 'finance' | 'scm' | null,
  quoteId: string,
): { to: string; label: string } | null {
  if (!linkTo) return null
  if (linkTo === 'sales') {
    return { to: `/sales/q/${quoteId}`, label: 'Open' }
  }
  if (linkTo === 'finance') {
    return { to: `/finance/q/${quoteId}/ovf`, label: 'Open' }
  }
  return { to: `/scm/q/${quoteId}/po`, label: 'Open' }
}

export function computeAdminPipelineSnapshot(records: SavedQuoteRecord[]) {
  const counts: Record<PipelineStageId, number> = {
    sales_quote_draft: 0,
    sales_no_ovf: 0,
    sales_ovf_draft: 0,
    finance_review: 0,
    finance_rejected: 0,
    scm_ready: 0,
    scm_po_draft: 0,
    scm_po_final: 0,
  }

  let finalQuotes = 0
  let totalQuotedInr = 0
  let withPoMatch = 0
  const pipelineWorkByDept: Record<'sales' | 'finance' | 'scm', number> = {
    sales: 0,
    finance: 0,
    scm: 0,
  }

  for (const r of records) {
    const { id } = classifyRecordStage(r)
    counts[id] = (counts[id] ?? 0) + 1
    const owner = getStageInfo(id).owner
    if (owner === 'sales' || owner === 'finance' || owner === 'scm') {
      pipelineWorkByDept[owner] = (pipelineWorkByDept[owner] ?? 0) + 1
    }
  }

  for (const r of records) {
    if (isQuoteDraft(r)) continue
    finalQuotes += 1
    const form = normalizeQuoteFormData(
      r.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
    const { total } = getQuoteMoneySummary(form)
    if (Number.isFinite(total)) totalQuotedInr += total
    if (poMatchLabel(form, r.po) === 'matched') withPoMatch += 1
  }

  return {
    counts,
    finalQuotes,
    totalDrafts: counts.sales_quote_draft,
    totalQuotedInr,
    withPoMatch,
    pipelineWorkByDept,
  }
}

export type AdminPipelineTableRow = {
  quoteId: string
  quoteRef: string
  customer: string
  stageId: PipelineStageId
  activityLabel: string
  link: { to: string; label: string } | null
}

export type AdminDeptFilter = 'sales' | 'finance' | 'scm'

export function pipelineStagesForDepartment(dept: AdminDeptFilter): PipelineStageId[] {
  return PIPELINE_STAGES.filter((id) => getStageInfo(id).owner === dept)
}

export function filterPipelineRowsByDepartment(
  rows: AdminPipelineTableRow[],
  dept: AdminDeptFilter,
): AdminPipelineTableRow[] {
  return rows.filter((row) => getStageInfo(row.stageId).owner === dept)
}

export function buildAdminPipelineTableRows(
  records: SavedQuoteRecord[],
  limit: number = 20,
): AdminPipelineTableRow[] {
  return [...records]
    .map((r) => {
      const { id, linkTo, quoteId } = classifyRecordStage(r)
      const form = normalizeQuoteFormData(
        r.formSnapshot as QuoteFormData & { customerTitle?: string },
      )
      const customer = (
        (r.ovf?.fields?.customerName || form.customerName) ??
        '—'
      )
        .toString()
        .trim() || '—'
      return {
        quoteId,
        quoteRef: (isQuoteDraft(r) ? 'Draft' : r.quoteRef || '—') as string,
        customer,
        stageId: id,
        activityLabel: new Date(activityMs(r)).toLocaleString(undefined, {
          dateStyle: 'short',
          timeStyle: 'short',
        }),
        link: adminLinkForRow(linkTo, quoteId),
      }
    })
    .sort((a, b) => {
      const ar = records.find((x) => x.id === a.quoteId)
      const br = records.find((x) => x.id === b.quoteId)
      return (br ? activityMs(br) : 0) - (ar ? activityMs(ar) : 0)
    })
    .slice(0, limit)
}
