import type {
  OvfFormFields,
  OvfProofAttachment,
  OvfStoredState,
  OvfWorkflowStatus,
} from '../types/ovf'
import { withDefaultOvfCountry } from './ovfFormDefaults'

export function effectiveOvfWorkflow(ovf: OvfStoredState | undefined): OvfWorkflowStatus {
  if (!ovf) return 'sales_draft'
  const s = ovf.workflowStatus
  if (
    s === 'sales_draft' ||
    s === 'pending_finance' ||
    s === 'finance_rejected' ||
    s === 'finance_approved'
  ) {
    return s
  }
  return 'sales_draft'
}

/** Preserve workflow / finance metadata while autosaving fields from the editor. */
export function mergeOvfForAutosave(
  existing: OvfStoredState | undefined,
  ovfRef: string,
  fields: OvfFormFields,
  /** When omitted, existing `proofAttachments` are kept unchanged. */
  proofAttachments?: OvfProofAttachment[],
): OvfStoredState {
  const fieldsNorm = withDefaultOvfCountry(fields)
  const nextProof =
    proofAttachments !== undefined ? proofAttachments : existing?.proofAttachments
  if (!existing) {
    return {
      ovfRef,
      fields: fieldsNorm,
      workflowStatus: 'sales_draft',
      ...(nextProof !== undefined ? { proofAttachments: nextProof } : {}),
    }
  }
  return {
    ...existing,
    ovfRef,
    fields: fieldsNorm,
    ...(nextProof !== undefined ? { proofAttachments: nextProof } : {}),
  }
}
