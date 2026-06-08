import type { OvfProofAttachment, OvfStoredState } from '../types/ovf'
import type {
  CustomerQuoteShipmentState,
  PoFinanceReviewState,
  QuoteFinanceReviewState,
} from '../types/quotePipeline'
import type { QuotePoState } from '../types/quotePo'
import type { QuoteFormData } from '../types/quotePdf'
import type { ScmGrmState } from '../types/scmGrm'
import type { ScmPoStoredState } from '../types/scmPo'

// Bump storage version to start fresh (ignore old test data in localStorage).
const STORAGE_KEY = 'scm_workflow_saved_quotes_v2'

/** Same key as persisted quotes; use for `storage` listeners so Finance refreshes when Sales updates another tab. */
export const SAVED_QUOTES_LOCAL_STORAGE_KEY = STORAGE_KEY

export type SavedQuoteRecord = {
  id: string
  savedAt: string
  savedBy: string
  /** Display name of the user who finalized the quote (OVF owner default, etc.). */
  savedByDisplayName?: string
  /** Empty while `kind` is `draft`. */
  quoteRef: string
  formSnapshot: QuoteFormData
  /** Legacy rows without `kind` are treated as final. */
  kind?: 'draft' | 'final'
  /** Customer PO file + declared total (finalized quotes only). */
  po?: QuotePoState
  /** Order verification form data (finalized quotes; PO matched). */
  ovf?: OvfStoredState
  /** SCM purchase order (finance-approved OVF only). */
  scmPo?: ScmPoStoredState
  /** Line-level goods receipt (GRN) on a saved PO. */
  scmGrm?: ScmGrmState
  /** Present when Sales finalized quote from imported vendor invoice → Finance quotes queue. */
  quoteFinanceReview?: QuoteFinanceReviewState
  /** Sales confirms quote email sent to buyer (gates customer PO upload in invoice flow). */
  customerQuoteShipment?: CustomerQuoteShipmentState
  /** Finance reviews matched customer PO (GST) before OVF is unlocked. */
  poFinanceReview?: PoFinanceReviewState
}

function parseStoredRecords(raw: unknown): SavedQuoteRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const r = item as SavedQuoteRecord
    const kind = r.kind === 'draft' ? ('draft' as const) : ('final' as const)
    if (kind === 'draft') {
      return {
        ...r,
        kind,
        quoteRef: '',
        formSnapshot: { ...r.formSnapshot, quoteRef: '' },
        ovf: undefined,
        scmPo: undefined,
        quoteFinanceReview: undefined,
        customerQuoteShipment: undefined,
        poFinanceReview: undefined,
      }
    }
    return {
      ...r,
      kind: 'final',
      quoteRef: r.quoteRef || '',
      ovf: r.ovf,
      scmPo: r.scmPo,
      scmGrm: r.scmGrm,
    }
  })
}

function readAll(): SavedQuoteRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return parseStoredRecords(arr)
  } catch {
    return []
  }
}

/** All saved quotes/OVFs/POs in this browser (admin + cross-department view). */
export function listAllSavedQuoteRecords(): SavedQuoteRecord[] {
  return readAll()
}

function dedupeProofAttachmentsByDataBase64(
  proofs: OvfProofAttachment[],
): OvfProofAttachment[] {
  const out: OvfProofAttachment[] = []
  const seen = new Set<string>()
  for (const p of proofs) {
    const key = (p.dataBase64 || '').trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * LocalStorage is tiny (~5MB). Our records can include base64 PDFs/XLSX.
 * Compact persisted data by removing duplicate attachment payloads that are stored elsewhere
 * on the same record (PO + vendor invoice are already stored in dedicated fields).
 */
function compactRecordForStorage(r: SavedQuoteRecord): SavedQuoteRecord {
  const poData = (r.po?.dataBase64 || '').trim()
  const viData = (r.quoteFinanceReview?.vendorInvoice?.dataBase64 || '').trim()
  const proofs = r.ovf?.proofAttachments
  if (!proofs || proofs.length === 0) return r

  const filtered = proofs.filter((p) => {
    const data = (p.dataBase64 || '').trim()
    if (!data) return false
    // Never duplicate the PO payload inside OVF proofs.
    if (poData && data === poData) return false
    // Never duplicate the primary vendor invoice payload inside OVF proofs.
    if (viData && data === viData) return false
    return true
  })

  const deduped = dedupeProofAttachmentsByDataBase64(filtered)
  if (deduped.length === proofs.length) return r

  return {
    ...r,
    ovf: r.ovf
      ? {
          ...r.ovf,
          proofAttachments: deduped,
        }
      : r.ovf,
  }
}

/** @returns false if storage is unavailable or quota / security blocked the write. */
function writeAll(records: SavedQuoteRecord[]): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false
  try {
    const compacted = records.map(compactRecordForStorage)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compacted))
    return true
  } catch {
    return false
  }
}

export function isQuoteDraft(record: SavedQuoteRecord): boolean {
  return record.kind === 'draft'
}

/** Matches official refs like QT-2026-001 (year + sequence). */
const QT_REF_RE = /^QT-(\d{4})-(\d+)$/i

/**
 * Highest trailing sequence number for `year` among **this user's** finalized
 * quotes (e.g. max 7 if QT-2026-007 exists). Drafts and other users' rows are
 * ignored so the next number matches what you see under “Your quotes”.
 */
export function getMaxFinalQuoteSequenceForYear(
  year: number,
  savedBy: string,
): number {
  let max = 0
  for (const r of readAll()) {
    if (r.savedBy !== savedBy) continue
    if (isQuoteDraft(r)) continue
    const m = r.quoteRef.trim().match(QT_REF_RE)
    if (!m) continue
    if (Number(m[1]) !== year) continue
    const n = parseInt(m[2], 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return max
}

/** Matches OVF refs like OVF-2026-001 (year + sequence). */
const OVF_REF_RE = /^OVF-(\d{4})-(\d+)$/i

/**
 * Highest OVF sequence for `year` among this user’s saved OVF refs
 * (from {@link SavedQuoteRecord.ovf}).
 */
export function getMaxFinalOvfSequenceForYear(
  year: number,
  savedBy: string,
): number {
  let max = 0
  for (const r of readAll()) {
    if (r.savedBy !== savedBy) continue
    const ref = r.ovf?.ovfRef?.trim()
    if (!ref) continue
    const m = ref.match(OVF_REF_RE)
    if (!m) continue
    if (Number(m[1]) !== year) continue
    const n = parseInt(m[2], 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return max
}

/** Matches PO refs like PO-2026-001 (year + sequence), per SCM creator oid. */
const PO_REF_RE = /^PO-(\d{4})-(\d+)$/i

export function getMaxScmPoSequenceForYear(year: number, scmSavedByOid: string): number {
  let max = 0
  for (const r of readAll()) {
    const p = r.scmPo
    if (!p || (p.scmSavedByOid || '').trim() !== scmSavedByOid) continue
    const ref = p.poRef?.trim()
    if (!ref) continue
    const m = ref.match(PO_REF_RE)
    if (!m) continue
    if (Number(m[1]) !== year) continue
    const n = parseInt(m[2], 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return max
}

export function getSavedQuoteByIdForUser(
  id: string,
  savedBy: string,
): SavedQuoteRecord | undefined {
  return readAll().find((r) => r.id === id && r.savedBy === savedBy)
}

/** New finalized quote (not from a draft row). */
export function appendSavedQuote(
  input: Omit<SavedQuoteRecord, 'id' | 'savedAt' | 'kind'> & {
    kind?: 'final'
  },
): SavedQuoteRecord {
  const record: SavedQuoteRecord = {
    ...input,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    kind: 'final',
    savedByDisplayName: input.savedByDisplayName?.trim() || undefined,
  }
  const all = readAll()
  all.unshift(record)
  writeAll(all)
  return record
}

/** Create or update a draft (no quote number; `formSnapshot.quoteRef` cleared). */
export function saveDraftQuote(input: {
  savedBy: string
  formSnapshot: QuoteFormData
  existingDraftId?: string | null
}): SavedQuoteRecord {
  const snapshot: QuoteFormData = { ...input.formSnapshot, quoteRef: '' }
  const all = readAll()
  if (input.existingDraftId) {
    const i = all.findIndex(
      (r) =>
        r.id === input.existingDraftId &&
        r.savedBy === input.savedBy &&
        isQuoteDraft(r),
    )
    if (i !== -1) {
      const updated: SavedQuoteRecord = {
        ...all[i],
        savedAt: new Date().toISOString(),
        formSnapshot: snapshot,
        quoteRef: '',
        kind: 'draft',
      }
      all[i] = updated
      writeAll(all)
      return updated
    }
  }
  const record: SavedQuoteRecord = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    savedBy: input.savedBy,
    quoteRef: '',
    formSnapshot: snapshot,
    kind: 'draft',
  }
  all.unshift(record)
  writeAll(all)
  return record
}

/** Turn a draft into a saved quote with an official number. */
export function finalizeDraftQuote(
  draftId: string,
  savedBy: string,
  quoteRef: string,
  formSnapshot: QuoteFormData,
  options?: {
    savedByDisplayName?: string
    quoteFinanceReview?: QuoteFinanceReviewState
    customerQuoteShipment?: CustomerQuoteShipmentState
    poFinanceReview?: PoFinanceReviewState
  },
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === draftId && r.savedBy === savedBy && isQuoteDraft(r),
  )
  if (i === -1) return null
  const snap: QuoteFormData = { ...formSnapshot, quoteRef }
  const displayName =
    options?.savedByDisplayName?.trim() ||
    all[i].savedByDisplayName?.trim() ||
    ''
  const pipeline = {
    ...(options?.quoteFinanceReview
      ? { quoteFinanceReview: options.quoteFinanceReview }
      : {}),
    ...(options?.customerQuoteShipment
      ? { customerQuoteShipment: options.customerQuoteShipment }
      : {}),
    ...(options?.poFinanceReview ? { poFinanceReview: options.poFinanceReview } : {}),
  }
  const updated: SavedQuoteRecord = {
    ...all[i],
    kind: 'final',
    quoteRef,
    formSnapshot: snap,
    savedAt: new Date().toISOString(),
    ...(displayName ? { savedByDisplayName: displayName } : {}),
    ...pipeline,
  }
  all[i] = updated
  writeAll(all)
  return updated
}

export function listSavedQuotesForUser(savedBy: string): SavedQuoteRecord[] {
  return readAll().filter((r) => r.savedBy === savedBy)
}

/** Any finalized quote by id (used by Finance / SCM; same browser storage). */
export function getSavedQuoteById(id: string): SavedQuoteRecord | undefined {
  return readAll().find((r) => r.id === id)
}

/**
 * Best-effort display label for the Sales user who owns saved quotes / vendor directory rows.
 */
export function resolveQuoteSavedByDisplayName(savedByOid: string): string {
  const oid = savedByOid.trim()
  if (!oid) return '—'
  for (const r of readAll()) {
    if (r.savedBy !== oid) continue
    const n = r.savedByDisplayName?.trim()
    if (n) return n
  }
  return 'Sales user'
}

/** Unique quote owners in storage (SCM/Finance: pick whose vendor directory receives a new row). */
export function listDistinctQuoteSavedByOids(): string[] {
  const seen = new Set<string>()
  for (const r of readAll()) {
    const oid = r.savedBy.trim()
    if (oid) seen.add(oid)
  }
  return [...seen].sort((a, b) =>
    resolveQuoteSavedByDisplayName(a).localeCompare(
      resolveQuoteSavedByDisplayName(b),
      undefined,
      { sensitivity: 'base' },
    ),
  )
}

function isFinalWithOvf(r: SavedQuoteRecord): boolean {
  return !isQuoteDraft(r) && Boolean(r.ovf)
}

/** Finance queue: OVF submitted and awaiting decision. */
export function listOvfPendingFinanceApproval(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      isFinalWithOvf(r) &&
      (r.ovf!.workflowStatus ?? 'sales_draft') === 'pending_finance',
  )
}

/** SCM queue: finance approved OVF (for PO planning). */
export function listOvfFinanceApprovedForScm(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      isFinalWithOvf(r) && r.ovf!.workflowStatus === 'finance_approved',
  )
}

/** Finalized quotes that already have an SCM PO block (draft or final). */
export function listSavedQuotesWithScmPo(): SavedQuoteRecord[] {
  // Show only POs that were actually created/saved (has a PO number).
  // This prevents "empty shell" PO records from showing up in SCM lists.
  return readAll().filter(
    (r) => !isQuoteDraft(r) && Boolean(r.scmPo && r.scmPo.poRef.trim()),
  )
}

/**
 * OVF ref used only by the removed `/scm/po/new` flow (`ScmPoNewPage` seeded `ovfRef: '—'`).
 * Those quote rows are empty shells; removing them is safe and clears junk PO list entries.
 */
const PO_NEW_PLACEHOLDER_OVF_REF = '—'

/** Returns how many records were removed. */
export function removeSavedQuotesSeededFromPoNew(): number {
  const all = readAll()
  const next = all.filter((r) => (r.ovf?.ovfRef ?? '').trim() !== PO_NEW_PLACEHOLDER_OVF_REF)
  const removed = all.length - next.length
  if (removed > 0) {
    writeAll(next)
  }
  return removed
}

/** Finance dashboard: OVFs Finance sent back to Sales (audit / context). */
export function listOvfFinanceRejected(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      isFinalWithOvf(r) && r.ovf!.workflowStatus === 'finance_rejected',
  )
}

/** Finance: finalized quotes awaiting quote + vendor invoice approval (invoice import path). */
export function listQuotesPendingFinanceReview(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      !isQuoteDraft(r) &&
      r.quoteFinanceReview?.workflowStatus === 'pending_finance',
  )
}

/** Finance dashboard: quotes Finance approved so Sales may send the quote to the customer. */
export function listQuotesFinanceApprovedForCustomer(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      !isQuoteDraft(r) &&
      r.quoteFinanceReview?.workflowStatus === 'finance_approved',
  )
}

/** Finance dashboard: quotes Finance rejected (invoice import path). */
export function listQuotesFinanceRejectedForCustomer(): SavedQuoteRecord[] {
  return readAll().filter(
    (r) =>
      !isQuoteDraft(r) &&
      r.quoteFinanceReview?.workflowStatus === 'finance_rejected',
  )
}

/** Finance: customer PO submitted for GST verification (invoice-import path). */
export function listCustomerPoPendingFinanceReview(): SavedQuoteRecord[] {
  return readAll().filter((r) => {
    if (isQuoteDraft(r) || !r.quoteFinanceReview || !r.po) return false
    return r.poFinanceReview?.workflowStatus === 'pending_finance'
  })
}

/** Finance decision on the quote phase (attached vendor invoice). */
export function mergeQuoteFinanceReviewOnRecord(
  quoteRecordId: string,
  patch: Partial<QuoteFinanceReviewState>,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === quoteRecordId && !isQuoteDraft(r))
  if (i === -1) return null
  const prev = all[i].quoteFinanceReview ?? ({} as QuoteFinanceReviewState)
  const merged: QuoteFinanceReviewState = { ...prev, ...patch }
  const nextRow: SavedQuoteRecord = {
    ...all[i],
    quoteFinanceReview: merged,
  }
  all[i] = nextRow
  return writeAll(all) ? nextRow : null
}

/** Finance decision on matched customer PO (GST etc.). */
export function mergePoFinanceReviewOnRecord(
  quoteRecordId: string,
  patch: Partial<PoFinanceReviewState>,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === quoteRecordId && !isQuoteDraft(r))
  if (i === -1) return null
  /** Approve/Reject GST must persist even when `poFinanceReview` was never initialized (race / legacy tabs). */
  const prev = all[i].poFinanceReview ?? ({} as PoFinanceReviewState)
  const merged: PoFinanceReviewState = { ...prev, ...patch }
  const nextRow: SavedQuoteRecord = {
    ...all[i],
    poFinanceReview: merged,
  }
  all[i] = nextRow
  return writeAll(all) ? nextRow : null
}

/**
 * Sales: force-create or update PO finance review state (used as a fallback when
 * a record did not yet initialize `poFinanceReview`).
 */
export function upsertPoFinanceReviewOnRecord(
  quoteRecordId: string,
  patch: Partial<PoFinanceReviewState>,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === quoteRecordId && !isQuoteDraft(r))
  if (i === -1) return null
  // Build a valid state even when `poFinanceReview` was missing.
  // Caller should include `workflowStatus` in the patch.
  const merged: PoFinanceReviewState = {
    ...(all[i].poFinanceReview ?? {}),
    ...patch,
  } as PoFinanceReviewState
  const nextRow: SavedQuoteRecord = {
    ...all[i],
    poFinanceReview: merged,
  }
  all[i] = nextRow
  return writeAll(all) ? nextRow : null
}

/** Sales: mark quotation sent to buyer (gates PO upload when quote came from invoice). */
export function setCustomerQuoteShipmentOnRecord(
  quoteRecordId: string,
  savedBy: string,
  shipment: CustomerQuoteShipmentState,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === quoteRecordId && r.savedBy === savedBy && !isQuoteDraft(r),
  )
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    customerQuoteShipment: shipment,
  }
  all[i] = next
  writeAll(all)
  return next
}

/**
 * Sales: submit matched customer PO to Finance for GST check.
 * Keyed by quote record id only (same browser storage as Finance), not `savedBy`, so submit matches
 * {@link mergeQuoteFinanceReviewOnRecord} / {@link mergePoFinanceReviewOnRecord} behaviour.
 */
export function submitMatchedPoToFinanceForRecord(
  quoteRecordId: string,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === quoteRecordId && !isQuoteDraft(r))
  if (i === -1) return null
  const row = all[i]
  if (!row.po) return null
  // Do not hard-block submitting due to match heuristics.
  // Finance can still reject after reviewing the PO + quote if something is off.
  const now = new Date().toISOString()
  const nextReview: PoFinanceReviewState = {
    workflowStatus: 'pending_finance',
    submittedToFinanceAt: now,
    financeRejectionNote: undefined,
  }
  const next: SavedQuoteRecord = {
    ...row,
    poFinanceReview: nextReview,
  }
  all[i] = next
  writeAll(all)
  return next
}

/**
 * Upsert SCM PO on a finalized quote (SCM user; quote may belong to Sales).
 * Caller must ensure OVF is finance-approved when first creating.
 */
export function updateSavedQuoteScmPo(
  id: string,
  scmPo: ScmPoStoredState,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === id && !isQuoteDraft(r))
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    scmPo: {
      ...scmPo,
      updatedAt: new Date().toISOString(),
    },
  }
  all[i] = next
  writeAll(all)
  return next
}

/** Upsert GRN (line receipt) on a quote that already has an SCM PO. */
export function updateSavedQuoteScmGrm(
  id: string,
  grm: ScmGrmState,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === id && !isQuoteDraft(r) && Boolean(r.scmPo))
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    scmGrm: {
      ...grm,
      updatedAt: new Date().toISOString(),
    },
  }
  all[i] = next
  writeAll(all)
  return next
}

/** Update OVF block on a finalized quote without scoping to `savedBy` (Finance decisions). */
export function updateSavedQuoteOvfByRecordId(
  id: string,
  ovf: OvfStoredState,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === id && !isQuoteDraft(r))
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    ovf: {
      ...ovf,
      updatedAt: new Date().toISOString(),
    },
  }
  all[i] = next
  writeAll(all)
  return next
}

/** Update PO attachment on a finalized quote. */
export function updateSavedQuotePo(
  id: string,
  savedBy: string,
  po: QuotePoState | undefined,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === id && r.savedBy === savedBy && !isQuoteDraft(r),
  )
  if (i === -1) return null
  const next: SavedQuoteRecord = { ...all[i], po }
  all[i] = next
  writeAll(all)
  return next
}

/** Persist OVF editor state on a finalized quote. */
export function updateSavedQuoteOvf(
  id: string,
  savedBy: string,
  ovf: OvfStoredState,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === id && r.savedBy === savedBy && !isQuoteDraft(r),
  )
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    ovf: {
      ...ovf,
      updatedAt: new Date().toISOString(),
    },
  }
  all[i] = next
  writeAll(all)
  return next
}

/** Update finalized quote form snapshot (e.g. OVF line-item edits by Sales). */
export function updateSavedQuoteFormSnapshot(
  id: string,
  savedBy: string,
  formSnapshot: QuoteFormData,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === id && r.savedBy === savedBy && !isQuoteDraft(r),
  )
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    formSnapshot,
    savedAt: new Date().toISOString(),
  }
  all[i] = next
  writeAll(all)
  return next
}

/**
 * Same as {@link updateSavedQuoteFormSnapshot} but keyed by record id only (local app).
 * Used to attach vendor rates from the invoice file for any workspace that can read the quote.
 */
export function updateSavedQuoteFormSnapshotByRecordId(
  id: string,
  formSnapshot: QuoteFormData,
): SavedQuoteRecord | null {
  const all = readAll()
  const i = all.findIndex((r) => r.id === id && !isQuoteDraft(r))
  if (i === -1) return null
  const next: SavedQuoteRecord = {
    ...all[i],
    formSnapshot,
    savedAt: new Date().toISOString(),
  }
  all[i] = next
  writeAll(all)
  return next
}

/** Permanently remove one draft for this user. Finalized quotes are not affected. */
export function deleteDraftForUser(id: string, savedBy: string): boolean {
  const all = readAll()
  const i = all.findIndex(
    (r) => r.id === id && r.savedBy === savedBy && isQuoteDraft(r),
  )
  if (i === -1) return false
  all.splice(i, 1)
  writeAll(all)
  return true
}
