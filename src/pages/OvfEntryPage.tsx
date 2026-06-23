import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { buildOvfSemanticHtml, parseGstPercent } from '../lib/generateOvf'
import {
  computeLineEconomics,
  computeOvfAggregateEconomics,
  normalizeVendorPurchaseMap,
} from '../lib/ovfVendorEconomics'
import { extraChargeInrFromField } from '../lib/ovfExtraCharges'
import {
  buildOvfPrefillFromQuote,
  createEmptyOvfFields,
  normalizeOvfFieldsFromStorage,
  OVF_VENDOR_PAYMENT_PRESET_DAYS,
  quoteSignatureOwnerLabel,
  normalizeExtractedPaymentTermsForOvf,
  vendorPaymentTermsPresetSelectValue,
} from '../lib/ovfFormDefaults'
import { allocateNextOvfRef } from '../lib/ovfRefSequence'
import { createEmptyLine, normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { filterCommercialLines } from '../lib/quoteLineItems'
import { canSalesCreateOvf, usesInvoiceQuotePipeline } from '../lib/quotePipeline'
import { lineAmount } from '../lib/quotePdfTemplate'
import { FinanceSubmitModal } from '../components/FinanceSubmitModal'
import { useSalesOvfPreviewShell } from '../components/SalesOvfPreviewShellContext'
import { buildOvfScmOverviewRow } from '../lib/ovfScmSummary'
import {
  getSavedQuoteById,
  isQuoteDraft,
  updateSavedQuoteFormSnapshot,
  updateSavedQuoteOvf,
  updateSavedQuoteOvfByRecordId,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import { allocateNextCompanyPoNumber } from '../lib/companyPoNumber'
import {
  enrichOvfPrefillFromAttachments,
  mergeCustomerPartyHintsIntoFields,
  mergeVendorPartyHintsIntoFields,
  parseCustomerPartyFromPoText,
  parseVendorPartyFromInvoiceText,
  pickVendorInvoiceAttachment,
  isInvalidExtractedVendorDisplayName,
  reconcileCustomerPartyAddressesForPersistedOvf,
  type CustomerPartyHints,
  type VendorPartyHints,
} from '../lib/extractOvfPartyDetails'
import { extractInvoiceRawTextForFooterScan, extractPoRawTextForPartyScan } from '../lib/extractInvoiceLineItems'
import { proofAttachmentBlob, quotePoBlob } from '../lib/quoteExport'
import {
  fetchCustomerPartyExtractOpenAI,
  fetchVendorPartyExtractOpenAI,
} from '../api/ovfPartyExtractApi'
import { effectiveOvfWorkflow, mergeOvfForAutosave } from '../lib/ovfWorkflow'
import type { OvfFormFields, OvfMoneyUnit, OvfProofAttachment } from '../types/ovf'
import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'

type OvfPageMode = 'sales' | 'finance' | 'scm'

/** Return path for Finance OVF back button when set via {@link Link} state from workflow details. */
function resolveFinanceOvfBackTo(quoteId: string, state: unknown): string {
  if (!quoteId.trim()) return '/finance'
  const raw = (state as { financeBackTo?: string } | null)?.financeBackTo?.trim()
  if (
    raw &&
    raw.startsWith('/finance/') &&
    raw.includes(quoteId) &&
    !raw.includes('..')
  ) {
    return raw
  }
  return '/finance'
}

/** Dedup OpenAI party extraction per quote + attachment payloads. */
function partyAiCacheKey(fresh: SavedQuoteRecord): string {
  // Bump this when heuristics change so existing OVFs re-run extraction.
  const VERSION = 5
  const po = fresh.po
  const vi = pickVendorInvoiceAttachment(fresh)
  // IMPORTANT: include upload timestamps + filenames so re-uploading the same file
  // (same base64) is treated as a *new* attachment and we re-run extraction.
  const poKey = po
    ? `${po.uploadedAt || ''}:${po.fileName || ''}:${(po.dataBase64 ?? '').length}`
    : 'no-po'
  const viKey = vi
    ? `${vi.uploadedAt || ''}:${vi.fileName || ''}:${(vi.dataBase64 ?? '').length}`
    : 'no-invoice'
  return `v${VERSION}:${fresh.id}:${poKey}:${viKey}`
}

/** Survives full page refresh (in-memory ref does not). Avoids re-blocking the OVF on PO/invoice AI. */
function partyAiSessionStorageKey(qid: string): string {
  return `ovf.partyAiMerged:${qid}`
}

function readPartyAiDoneFromSession(qid: string): string | null {
  try {
    return sessionStorage.getItem(partyAiSessionStorageKey(qid))
  } catch {
    return null
  }
}

function writePartyAiDoneToSession(qid: string, key: string): void {
  try {
    sessionStorage.setItem(partyAiSessionStorageKey(qid), key)
  } catch {
    /* quota / private mode */
  }
}

/** GST % choices for OVF customer / vendor charge tables (stored without “%”). */
const OVF_GST_PERCENT_PRESETS = ['0', '5', '12', '18', '28'] as const

function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Trimmed non-empty string (OVF text fields). */
function trimmedOvfText(s: string | undefined | null): string {
  return String(s ?? '').trim()
}

function combineCustomerPartyHints(
  heuristic: CustomerPartyHints,
  llm: CustomerPartyHints,
): CustomerPartyHints {
  const keys: (keyof CustomerPartyHints)[] = [
    'customerName',
    'contactPerson',
    'customerPoNumber',
    'billingAddress',
    'shippingAddress',
    'billingState',
    'shippingState',
    'contactNumber',
    'contactEmail',
    'customerPaymentTerms',
  ]
  const out: CustomerPartyHints = {}
  for (const k of keys) {
    const lt = llm[k]?.trim()
    const ht = heuristic[k]?.trim()
    if (lt) out[k] = lt
    else if (ht) out[k] = ht
  }
  return out
}

function combineVendorPartyHints(
  heuristic: VendorPartyHints,
  llm: VendorPartyHints,
): VendorPartyHints {
  const keys: (keyof VendorPartyHints)[] = [
    'vendorName',
    'vendorPoNumber',
    'vendorContactNumber',
    'vendorEmailId',
    'vendorPaymentTerms',
  ]
  const out: VendorPartyHints = {}
  for (const k of keys) {
    let lt = llm[k]?.trim() ?? ''
    if (k === 'vendorName' && isInvalidExtractedVendorDisplayName(lt)) lt = ''
    const ht = heuristic[k]?.trim()
    if (lt) out[k] = lt
    else if (ht) out[k] = ht
  }
  return out
}

function normalizeCustomerHintsForForm(h: CustomerPartyHints): CustomerPartyHints {
  const o = { ...h }
  if (o.customerPaymentTerms?.trim()) {
    const n = normalizeExtractedPaymentTermsForOvf(o.customerPaymentTerms)
    if (n) o.customerPaymentTerms = n
  }
  return o
}

function normalizeVendorHintsForForm(h: VendorPartyHints): VendorPartyHints {
  const o = { ...h }
  if (o.vendorName?.trim() && isInvalidExtractedVendorDisplayName(o.vendorName)) {
    o.vendorName = ''
  }
  if (o.vendorPaymentTerms?.trim()) {
    const n = normalizeExtractedPaymentTermsForOvf(o.vendorPaymentTerms)
    if (n) o.vendorPaymentTerms = n
  }
  return o
}

/** Read-only OVF (Finance / SCM / locked Sales): hide labels for fields Sales left blank. */
function showOvfTextField(readOnly: boolean, raw: string | undefined | null): boolean {
  if (!readOnly) return true
  return trimmedOvfText(raw) !== ''
}

const MAX_OVF_PROOF_BYTES = 1_800_000
const MAX_OVF_PROOF_FILES = 12

/** Do not back-fill from quote snapshot when extraction leaves these empty. */
const CUSTOMER_PARTY_NO_QUOTE_FALLBACK: (keyof OvfFormFields)[] = [
  'customerName',
  'billingAddress',
  'shippingAddress',
]

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('read_failed'))
    }
    reader.onerror = () => reject(new Error('read_failed'))
    reader.readAsDataURL(file)
  })
}

function OvfDownloadIcon() {
  return (
    <svg
      className="ovf-entry__download-icon-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
      />
    </svg>
  )
}

function OvfAutoTextarea({
  value,
  onChange,
  minRows,
  className,
  readOnly,
}: {
  value: string
  onChange: (v: string) => void
  minRows: number
  className?: string
  readOnly?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const syncHeight = useCallback(() => {
    const el = ref.current
    if (!el) return
    const cs = getComputedStyle(el)
    const line =
      parseFloat(cs.lineHeight) ||
      parseFloat(cs.fontSize) * 1.4 ||
      22
    const minPx = line * minRows
    const cap = Math.min(window.innerHeight * 0.65, 520)
    el.style.height = '0px'
    const target = Math.min(Math.max(el.scrollHeight, minPx), cap)
    el.style.height = `${target}px`
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden'
  }, [minRows])

  useLayoutEffect(() => {
    syncHeight()
  }, [value, syncHeight])

  return (
    <textarea
      ref={ref}
      value={value}
      className={className}
      rows={1}
      spellCheck
      readOnly={readOnly}
      onChange={(e) => {
        if (readOnly) return
        onChange(e.target.value)
        requestAnimationFrame(() => syncHeight())
      }}
    />
  )
}

export function OvfEntryPage({
  mode = 'sales' as OvfPageMode,
  embeddedInModal = false,
  /** When set (e.g. Sales dashboard OVF preview modal), quote id is not on the current route. */
  modalQuoteId,
}: {
  mode?: OvfPageMode
  /** When true (e.g. dashboard preview), hide nav chrome; use full URLs for outbound links. */
  embeddedInModal?: boolean
  modalQuoteId?: string
}) {
  const { quoteId: routeQuoteId } = useParams<{ quoteId: string }>()
  const quoteId = (modalQuoteId ?? routeQuoteId) || ''
  const navigate = useNavigate()
  const location = useLocation()
  const financeBackTo = useMemo(
    () => resolveFinanceOvfBackTo(quoteId, location.state),
    [quoteId, location.state],
  )
  const [searchParams] = useSearchParams()
  const { user, getAccessToken } = useAuth()
  const [record, setRecord] = useState<SavedQuoteRecord | null | undefined>(
    undefined,
  )
  const [ovfReady, setOvfReady] = useState(false)
  const [fields, setFields] = useState<OvfFormFields>(createEmptyOvfFields)
  const [ovfRef, setOvfRef] = useState('')
  const [financeModalOpen, setFinanceModalOpen] = useState(false)
  const [ovfBootstrapBlock, setOvfBootstrapBlock] = useState<string | null>(
    null,
  )
  const [shareNotice, setShareNotice] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [showRejectPanel, setShowRejectPanel] = useState(false)
  const [proofAttachments, setProofAttachments] = useState<OvfProofAttachment[]>([])
  const [editingCustomerLineId, setEditingCustomerLineId] = useState<string | null>(null)
  const [editingCustomerLineDraft, setEditingCustomerLineDraft] = useState<QuoteLineForm | null>(
    null,
  )
  /** One-time merge of invoice/PO party hints for drafts created before extraction existed. */
  const ovfPartyHintsAppliedRef = useRef<string | null>(null)
  /** After pref ill + heuristic merge, apply OpenAI once per PO/vendor attachment snapshot. */
  const openAiPartyMergedRef = useRef<string | null>(null)
  /** Hide OVF body until PO/invoice AI extraction completes (otherwise quote prefill flashes ~5s). */
  const [ovfPartyAiHydrating, setOvfPartyAiHydrating] = useState(false)
  /** Short overlay while details are being extracted; never blocks for long. */
  const [ovfPartyAiOverlayVisible, setOvfPartyAiOverlayVisible] = useState(false)
  // Vendor purchase: vendor unit is edited inline (no row edit mode).

  const reload = useCallback(() => {
    if (!quoteId) {
      setRecord(null)
      return
    }
    const row = getSavedQuoteById(quoteId)
    if (mode === 'sales') {
      if (!user) {
        setRecord(null)
        return
      }
      if (row && row.savedBy !== user.oid) {
        setRecord(null)
        return
      }
    }
    setRecord(row ?? null)
  }, [user, quoteId, mode])

  useEffect(() => {
    reload()
  }, [reload])

  const data = useMemo(() => {
    if (!record) return null
    return normalizeQuoteFormData(
      record.formSnapshot as QuoteFormData & { customerTitle?: string },
    )
  }, [record])

  const wf = effectiveOvfWorkflow(record?.ovf)
  /** Sales: read-only preview (dashboard modal or `?view=1` on the OVF route). */
  const viewOnlySales =
    mode === 'sales' &&
    (embeddedInModal || searchParams.get('view') === '1')
  const salesCanEdit =
    mode === 'sales' &&
    (wf === 'sales_draft' || wf === 'finance_rejected') &&
    !viewOnlySales
  const readOnly = mode !== 'sales' || !salesCanEdit
  /** No OVF HTML download while Sales is still in draft (creating); show after send to Finance or for other roles. */
  const showOvfHtmlDownload = !(mode === 'sales' && wf === 'sales_draft')
  /** SCM may fill in freight/finance after Finance approval (outside the read-only `inert` shell). */
  const scmCanEditFreightFinance = mode === 'scm' && wf === 'finance_approved'
  /** SCM may correct internal company PO while with Finance or after approval (outside `inert`). */
  const scmCanEditCompanyPo =
    mode === 'scm' && (wf === 'pending_finance' || wf === 'finance_approved')
  const freightFinanceReadOnly = readOnly && !scmCanEditFreightFinance

  const scmOverview = useMemo(
    () => (record ? buildOvfScmOverviewRow(record) : null),
    [record],
  )
  /** SCM full-page OVF: HTML download lives in the overview header instead of the bottom actions row. */
  const scmOvfHtmlDownloadInOverview =
    mode === 'scm' &&
    Boolean(scmOverview) &&
    showOvfHtmlDownload &&
    !embeddedInModal

  /** Before paint: show loading shell while AI party extraction will run (matches OpenAI effect guards). */
  useLayoutEffect(() => {
    if (mode !== 'sales' || viewOnlySales || !ovfReady || !record?.ovf || !user) {
      setOvfPartyAiHydrating(false)
      return
    }
    if (record.savedBy !== user.oid) {
      setOvfPartyAiHydrating(false)
      return
    }
    const wf = effectiveOvfWorkflow(record.ovf)
    if (wf !== 'sales_draft' && wf !== 'finance_rejected') {
      setOvfPartyAiHydrating(false)
      return
    }
    const fresh = getSavedQuoteById(quoteId)
    if (!fresh?.ovf) {
      setOvfPartyAiHydrating(false)
      return
    }
    const po = fresh.po
    const vi = pickVendorInvoiceAttachment(fresh)
    if (!po?.dataBase64?.trim() && !vi?.dataBase64?.trim()) {
      setOvfPartyAiHydrating(false)
      return
    }
    const cacheKey = partyAiCacheKey(fresh)
    if (cacheKey === openAiPartyMergedRef.current) {
      setOvfPartyAiHydrating(false)
      return
    }
    if (readPartyAiDoneFromSession(quoteId) === cacheKey) {
      openAiPartyMergedRef.current = cacheKey
      setOvfPartyAiHydrating(false)
      return
    }
    setOvfPartyAiHydrating(true)
  }, [
    mode,
    viewOnlySales,
    ovfReady,
    quoteId,
    user,
    record?.id,
    record?.savedBy,
    record?.ovf,
    record?.po?.dataBase64,
    record?.quoteFinanceReview?.vendorInvoice?.dataBase64,
  ])

  /** If party AI hangs (token, xlsx parse, network), never leave the full-page gate up forever. */
  useEffect(() => {
    if (!ovfPartyAiHydrating) return
    const id = window.setTimeout(() => setOvfPartyAiHydrating(false), 45_000)
    return () => window.clearTimeout(id)
  }, [ovfPartyAiHydrating])

  useEffect(() => {
    if (!ovfPartyAiHydrating) {
      setOvfPartyAiOverlayVisible(false)
      return
    }
    setOvfPartyAiOverlayVisible(true)
    // Show briefly; extraction continues in background if slower.
    const id = window.setTimeout(() => setOvfPartyAiOverlayVisible(false), 6000)
    return () => window.clearTimeout(id)
  }, [ovfPartyAiHydrating])

  /** Sales: allocate OVF# or load saved OVF once per quote (not re-run on autosave). */
  useEffect(() => {
    if (!user || !quoteId || mode !== 'sales') return

    const fresh = getSavedQuoteById(quoteId)
    if (!fresh || fresh.savedBy !== user.oid || isQuoteDraft(fresh)) return

    if (!canSalesCreateOvf(fresh)) {
      setOvfBootstrapBlock(
        usesInvoiceQuotePipeline(fresh)
          ? 'Finance must approve the customer PO (GST check) before you can create the OVF.'
          : 'Upload a customer PO before you can work on the OVF.',
      )
      setOvfReady(true)
      return
    }
    setOvfBootstrapBlock(null)

    if (fresh.ovf) {
      setRecord(fresh)
      setProofAttachments(fresh.ovf.proofAttachments ?? [])
      const empty = createEmptyOvfFields()
      const ownerHint =
        quoteSignatureOwnerLabel(fresh).trim() ||
        (user.displayName ?? '').trim()
      const normalized = normalizeOvfFieldsFromStorage(fresh.ovf.fields)
      const baseFields = {
        ...normalized,
        vendorPurchaseUnitByLineId: {
          ...empty.vendorPurchaseUnitByLineId,
          ...(normalized.vendorPurchaseUnitByLineId ?? {}),
        },
      }
      setFields(
        reconcileCustomerPartyAddressesForPersistedOvf({
          ...baseFields,
          ovfModuleOwner: baseFields.ovfModuleOwner.trim() || ownerHint,
        }),
      )
      setOvfRef(fresh.ovf.ovfRef)
      setOvfReady(true)
      return
    }

    const ref = allocateNextOvfRef(user.oid)
    const prefillBase = buildOvfPrefillFromQuote(fresh)
    const sessionOwner = (user.displayName ?? '').trim()
    const prefillSync0 =
      !prefillBase.ovfModuleOwner.trim() && sessionOwner
        ? { ...prefillBase, ovfModuleOwner: sessionOwner }
        : prefillBase
    const vi = fresh.quoteFinanceReview?.vendorInvoice
    const seedProofs: OvfProofAttachment[] = []
    if (vi) {
      seedProofs.push({ ...vi, id: crypto.randomUUID() })
    }
    if (fresh.po) {
      seedProofs.push({
        id: crypto.randomUUID(),
        fileName: fresh.po.fileName,
        mimeType: fresh.po.mimeType,
        dataBase64: fresh.po.dataBase64,
        uploadedAt: fresh.po.uploadedAt,
      })
    }

    const hasPartySources = Boolean(vi?.dataBase64 || fresh.po?.dataBase64)

    const prefillSync = prefillSync0
    const customerPartyKeys: (keyof OvfFormFields)[] = [
      'customerName',
      'contactPerson',
      'customerPoNumber',
      'billingAddress',
      'shippingAddress',
      'billingState',
      'shippingState',
      'contactNumber',
      'contactEmail',
      'customerPaymentTerms',
    ]
    const vendorPartyKeys: (keyof OvfFormFields)[] = [
      'vendorName',
      'vendorAddressDetail',
      'vendorPoNumber',
      'vendorContactNumber',
      'vendorEmailId',
      'vendorPaymentTerms',
    ]

    const persistNewOvf = (prefill: typeof prefillSync) => {
      const next = updateSavedQuoteOvf(quoteId, user.oid, {
        ovfRef: ref,
        fields: prefill,
        workflowStatus: 'sales_draft',
        proofAttachments: seedProofs,
      })
      if (next) {
        setRecord(next)
        setFields(reconcileCustomerPartyAddressesForPersistedOvf(prefill))
        setOvfRef(ref)
      } else {
        setFields(reconcileCustomerPartyAddressesForPersistedOvf(prefill))
        setOvfRef(ref)
      }
      setProofAttachments(seedProofs)
      setOvfReady(true)
    }

    if (!hasPartySources) {
      persistNewOvf(prefillSync)
      return
    }

    void (async () => {
      // Step 1: Extract party details from PO / vendor invoice first.
      // Step 2: Fill any remaining blanks from the quote snapshot (manual fallback).
      let prefill = prefillSync
      try {
        // Build a base where party blocks are blank, so extraction isn't "competing" with quote-prefill.
        const extractionBase = { ...prefillSync }
        for (const k of [...customerPartyKeys, ...vendorPartyKeys]) {
          ;(extractionBase as unknown as Record<string, string>)[String(k)] = ''
        }

        const extracted = await enrichOvfPrefillFromAttachments(extractionBase, fresh)

        // Apply extracted values first, then fallback to quote-prefill only where still empty.
        const merged: typeof prefillSync = { ...prefillSync }
        for (const k of [...customerPartyKeys, ...vendorPartyKeys]) {
          const ev = String(extracted[k] ?? '').trim()
          const qv = String(prefillSync[k] ?? '').trim()
          const skipQuoteFallback = CUSTOMER_PARTY_NO_QUOTE_FALLBACK.includes(
            k as keyof OvfFormFields,
          )
          if (ev) {
            ;(merged as unknown as Record<string, string>)[String(k)] = ev
          } else if (!skipQuoteFallback && qv) {
            ;(merged as unknown as Record<string, string>)[String(k)] = qv
          } else {
            ;(merged as unknown as Record<string, string>)[String(k)] = ''
          }
        }

        prefill = reconcileCustomerPartyAddressesForPersistedOvf(merged)
      } catch {
        prefill = prefillSync
      }
      persistNewOvf(prefill)
    })()
  }, [user, quoteId, mode])

  /** Sales draft: one-time fill of vendor/customer blocks from invoice + PO text where fields are still empty. */
  useEffect(() => {
    if (!user || !quoteId || mode !== 'sales' || !ovfReady || !record?.ovf) return
    if (viewOnlySales) return
    if (
      record.ovf.workflowStatus !== 'sales_draft' &&
      record.ovf.workflowStatus !== 'finance_rejected'
    ) {
      return
    }

    const viAtt = pickVendorInvoiceAttachment(record)
    const vKeys: (keyof OvfFormFields)[] = [
      'vendorName',
      'vendorPoNumber',
      'vendorContactNumber',
      'vendorEmailId',
      'vendorPaymentTerms',
    ]
    const cKeys: (keyof OvfFormFields)[] = [
      'customerName',
      'contactPerson',
      'customerPoNumber',
      'billingAddress',
      'shippingAddress',
      'billingState',
      'shippingState',
      'contactNumber',
      'contactEmail',
      'customerPaymentTerms',
    ]
    const ovf = record.ovf
    const needsVendor =
      Boolean(viAtt?.dataBase64) &&
      vKeys.some((k) => !trimmedOvfText(String(ovf.fields[k])))
    /** Re-run merge once so PO text can replace or enrich quote-prefilled customer rows. */
    const needsCustomerParty = Boolean(record.po?.dataBase64)
    if (!needsVendor && !needsCustomerParty) return

    const key = `${record.id}-ovf-party-hints:${partyAiCacheKey(record)}`
    if (ovfPartyHintsAppliedRef.current === key) return
    ovfPartyHintsAppliedRef.current = key

    void (async () => {
      try {
        const enriched = await enrichOvfPrefillFromAttachments(
          record.ovf!.fields,
          record,
        )
        setFields((prev) => {
          const n = { ...prev } as unknown as Record<string, string>
          const partyKeys = [...vKeys, ...cKeys] as (keyof OvfFormFields)[]

          // Clear obviously bogus phone numbers that older parsers could inject.
          const curPhone = trimmedOvfText(String(prev.contactNumber))
          if (/^0{3,}\d{4,}$/.test(curPhone) || /0{3,}1?5?0{3,}/.test(curPhone)) {
            n.contactNumber = ''
          }

          for (const k of partyKeys) {
            const ev = enriched[k]
            if (typeof ev !== 'string') continue
            const prevVal = trimmedOvfText(String(prev[k as keyof OvfFormFields]))
            const nextTrim = ev.trim()
            // Never overwrite existing values with empty extraction output (merge leaves gaps).
            if (nextTrim) {
              n[String(k)] = nextTrim
            } else if (!prevVal) {
              n[String(k)] = ev
            }
          }
          return reconcileCustomerPartyAddressesForPersistedOvf(n as unknown as OvfFormFields)
        })
      } catch {
        ovfPartyHintsAppliedRef.current = null
      }
    })()
  }, [
    user,
    quoteId,
    mode,
    ovfReady,
    viewOnlySales,
    record?.id,
    record?.ovf?.workflowStatus,
    record?.quoteFinanceReview?.vendorInvoice?.dataBase64,
    record?.po?.dataBase64,
  ])

  /**
   * Party fields: merge heuristic text parsing from PO + vendor invoice with optional OpenAI enrichment.
   * Heuristics always run when PDF/text yields enough characters; LLM fills gaps when the API is configured.
   */
  useEffect(() => {
    void (async () => {
      try {
        if (!user || !quoteId || mode !== 'sales' || !ovfReady || viewOnlySales) return

        const fresh = getSavedQuoteById(quoteId)
        if (!fresh?.ovf || fresh.savedBy !== user.oid) return

        const wf = effectiveOvfWorkflow(fresh.ovf)
        if (wf !== 'sales_draft' && wf !== 'finance_rejected') return

        const po = fresh.po
        const vi = pickVendorInvoiceAttachment(fresh)
        if (!po?.dataBase64?.trim() && !vi?.dataBase64?.trim()) return

        const key = partyAiCacheKey(fresh)
        if (openAiPartyMergedRef.current === key) return

        if (readPartyAiDoneFromSession(quoteId) === key) {
          openAiPartyMergedRef.current = key
          return
        }

        const token = await getAccessToken()

        try {
          let customerHints: CustomerPartyHints = {}
          let vendorHints: VendorPartyHints = {}
          let applyCustomerHints = false
          let applyVendorHints = false

          if (po?.dataBase64?.trim()) {
            const blob = quotePoBlob(po)
            const file = new File([blob], po.fileName || 'po', {
              type: po.mimeType || blob.type || 'application/octet-stream',
            })
            const text = await extractPoRawTextForPartyScan(file)
            if (text.trim().length >= 15) {
              const heur = parseCustomerPartyFromPoText(text)
              let merged = normalizeCustomerHintsForForm(heur)
              if (token) {
                const ai = await fetchCustomerPartyExtractOpenAI(token, text)
                if (ai.ok) {
                  merged = normalizeCustomerHintsForForm(
                    combineCustomerPartyHints(heur, ai.hints),
                  )
                }
              }
              customerHints = merged
              applyCustomerHints = Object.keys(customerHints).length > 0
            }
          }

          if (vi?.dataBase64?.trim()) {
            const blob = proofAttachmentBlob(vi)
            const file = new File([blob], vi.fileName || 'invoice', {
              type: vi.mimeType || blob.type || 'application/octet-stream',
            })
            const text = await extractInvoiceRawTextForFooterScan(file)
            if (text.trim().length >= 15) {
              const heur = parseVendorPartyFromInvoiceText(text)
              let merged = normalizeVendorHintsForForm(heur)
              if (token) {
                const ai = await fetchVendorPartyExtractOpenAI(token, text)
                if (ai.ok) {
                  merged = normalizeVendorHintsForForm(
                    combineVendorPartyHints(heur, ai.hints),
                  )
                }
              }
              vendorHints = merged
              applyVendorHints = Object.keys(vendorHints).length > 0
            }
          }

          if (applyCustomerHints || applyVendorHints) {
            setFields((prev) => {
              let next = prev
              if (applyCustomerHints) {
                next = mergeCustomerPartyHintsIntoFields(next, customerHints)
              }
              if (applyVendorHints) {
                next = mergeVendorPartyHintsIntoFields(next, vendorHints)
              }
              return reconcileCustomerPartyAddressesForPersistedOvf(next)
            })
          }
          openAiPartyMergedRef.current = key
          writePartyAiDoneToSession(quoteId, key)
        } catch {
          openAiPartyMergedRef.current = null
        }
      } finally {
        setOvfPartyAiHydrating(false)
      }
    })()
  }, [
    user,
    quoteId,
    mode,
    ovfReady,
    viewOnlySales,
    record?.id,
    record?.po?.dataBase64,
    record?.quoteFinanceReview?.vendorInvoice?.dataBase64,
    record?.ovf?.proofAttachments,
    getAccessToken,
  ])

  /** Finance / SCM: hydrate editor state from stored quote (read-only). */
  useEffect(() => {
    if (mode === 'sales' || !quoteId) return
    const fresh = getSavedQuoteById(quoteId)
    if (!fresh || isQuoteDraft(fresh) || !fresh.ovf) {
      setProofAttachments([])
      setOvfReady(false)
      return
    }
    const empty = createEmptyOvfFields()
    const normalized = normalizeOvfFieldsFromStorage(fresh.ovf.fields)
    const baseFields = {
      ...normalized,
      vendorPurchaseUnitByLineId: {
        ...empty.vendorPurchaseUnitByLineId,
        ...(normalized.vendorPurchaseUnitByLineId ?? {}),
      },
    }
    setFields(
      reconcileCustomerPartyAddressesForPersistedOvf({
        ...baseFields,
        ovfModuleOwner:
          baseFields.ovfModuleOwner.trim() ||
          quoteSignatureOwnerLabel(fresh).trim(),
      }),
    )
    setProofAttachments(fresh.ovf.proofAttachments ?? [])
    setOvfRef(fresh.ovf.ovfRef)
    setOvfReady(true)
  }, [mode, quoteId, record?.id, wf, record?.ovf?.ovfRef])

  const workflowForSave = effectiveOvfWorkflow(record?.ovf)

  useEffect(() => {
    if (!ovfReady || !quoteId || !user || !ovfRef || mode !== 'sales') return
    if (viewOnlySales) return
    if (workflowForSave !== 'sales_draft' && workflowForSave !== 'finance_rejected') {
      return
    }
    const t = window.setTimeout(() => {
      const fresh = getSavedQuoteById(quoteId)
      const merged = mergeOvfForAutosave(fresh?.ovf, ovfRef, fields, proofAttachments)
      const next = updateSavedQuoteOvf(quoteId, user.oid, merged)
      if (next) setRecord(next)
    }, 450)
    return () => window.clearTimeout(t)
  }, [
    fields,
    proofAttachments,
    mode,
    ovfRef,
    ovfReady,
    quoteId,
    user,
    viewOnlySales,
    workflowForSave,
  ])

  /** SCM: persist freight/finance and/or company PO (and rest of OVF fields) without changing workflow. */
  useEffect(() => {
    if (!ovfReady || !quoteId || !ovfRef) return
    if (!scmCanEditFreightFinance && !scmCanEditCompanyPo) return
    const t = window.setTimeout(() => {
      const fresh = getSavedQuoteById(quoteId)
      if (!fresh?.ovf) return
      const merged = mergeOvfForAutosave(fresh.ovf, ovfRef, fields)
      const next = updateSavedQuoteOvfByRecordId(quoteId, merged)
      if (next) setRecord(next)
    }, 450)
    return () => window.clearTimeout(t)
  }, [fields, ovfReady, ovfRef, quoteId, scmCanEditFreightFinance, scmCanEditCompanyPo])

  const patchField = useCallback((key: keyof OvfFormFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
  }, [])

  const patchVendorPurchaseUnit = useCallback((lineId: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      vendorPurchaseUnitByLineId: {
        ...prev.vendorPurchaseUnitByLineId,
        [lineId]: value,
      },
    }))
  }, [])

  const persistQuoteLines = useCallback(
    (updater: (lines: QuoteLineForm[]) => QuoteLineForm[]) => {
      if (!record || !user || !quoteId) return
      const snap = record.formSnapshot as QuoteFormData
      const currentLines = Array.isArray(snap.lineItems) ? snap.lineItems : []
      const nextLines = updater(currentLines.map((ln) => ({ ...ln })))
      const nextSnapshot: QuoteFormData = { ...snap, lineItems: nextLines }
      const next = updateSavedQuoteFormSnapshot(quoteId, user.oid, nextSnapshot)
      if (next) {
        setRecord(next)
      }
    },
    [record, user, quoteId],
  )

  const proofListForDisplay = useMemo(() => {
    if (salesCanEdit) return proofAttachments
    return record?.ovf?.proofAttachments ?? []
  }, [salesCanEdit, proofAttachments, record?.ovf?.proofAttachments])

  const addProofAttachmentsFromFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length || !user || !quoteId) return
      const picked = Array.from(fileList)
      const additions: OvfProofAttachment[] = []
      let skippedLarge = 0
      let readErr = 0
      for (const file of picked) {
        if (additions.length >= MAX_OVF_PROOF_FILES) break
        if (file.size > MAX_OVF_PROOF_BYTES) {
          skippedLarge += 1
          continue
        }
        try {
          const dataBase64 = await readFileAsDataUrl(file)
          additions.push({
            id: crypto.randomUUID(),
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64,
            uploadedAt: new Date().toISOString(),
          })
        } catch {
          readErr += 1
        }
      }
      if (additions.length === 0) {
        if (skippedLarge || readErr) {
          setShareNotice(
            `Could not add files${skippedLarge ? ` (${skippedLarge} over size limit)` : ''}${readErr ? ` (${readErr} read error(s))` : ''}.`,
          )
          window.setTimeout(() => setShareNotice(null), 7000)
        }
        return
      }
      setProofAttachments((prev) => {
        const room = MAX_OVF_PROOF_FILES - prev.length
        if (room <= 0) return prev
        return [...prev, ...additions.slice(0, room)]
      })
      if (skippedLarge || readErr || picked.length > additions.length) {
        setShareNotice(
          `Added ${additions.length} file(s).${skippedLarge ? ` Skipped ${skippedLarge} (too large).` : ''}${readErr ? ` Skipped ${readErr} (read error).` : ''}`,
        )
        window.setTimeout(() => setShareNotice(null), 7000)
      }
    },
    [user, quoteId],
  )

  const removeProofAttachment = useCallback((id: string) => {
    setProofAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const commercial = useMemo(
    () => (data ? filterCommercialLines(data.lineItems) : []),
    [data],
  )

  const vendorPurchaseMap = useMemo(
    () => normalizeVendorPurchaseMap(fields),
    [fields],
  )

  const effectiveOvfLine = useCallback(
    (ln: QuoteLineForm): QuoteLineForm => {
      let m = ln
      if (
        salesCanEdit &&
        editingCustomerLineId === ln.id &&
        editingCustomerLineDraft
      ) {
        m = { ...m, ...editingCustomerLineDraft }
      }
      return m
    },
    [
      salesCanEdit,
      editingCustomerLineId,
      editingCustomerLineDraft,
    ],
  )

  const aggEco = useMemo(
    () => computeOvfAggregateEconomics(commercial, vendorPurchaseMap),
    [commercial, vendorPurchaseMap],
  )

  const gstRate = parseGstPercent(fields.gstPercent)

  const { gstPercentSelectValue, gstPercentNeedsSavedOption } = useMemo(() => {
    const t = trimmedOvfText(fields.gstPercent.replace(/,/g, ''))
    const v = t === '' ? '18' : t
    const presets = OVF_GST_PERCENT_PRESETS as readonly string[]
    return {
      gstPercentSelectValue: v,
      gstPercentNeedsSavedOption: !presets.includes(v),
    }
  }, [fields.gstPercent])

  const customerPaymentTermsPresetValue = vendorPaymentTermsPresetSelectValue(
    fields.customerPaymentTerms,
  )
  const customerPaymentTermsHasSavedCustom =
    customerPaymentTermsPresetValue === 'manual' &&
    trimmedOvfText(fields.customerPaymentTerms) !== ''

  const handleDownloadHtml = useCallback(() => {
    if (!record?.ovf || !data) return
    const html = buildOvfSemanticHtml(
      data.quoteRef || record.quoteRef || 'quote',
      ovfRef,
      fields,
      commercial,
    )
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const safe = record.ovf.ovfRef.replace(/[^\w.-]+/g, '_')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `OVF-${safe}.html`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [record, data, ovfRef, fields, commercial])

  const ovfPreviewShell = useSalesOvfPreviewShell()
  useEffect(() => {
    if (!embeddedInModal || !ovfPreviewShell) return
    if (!showOvfHtmlDownload) {
      ovfPreviewShell.setHtmlDownloadHandler(null)
      return () => ovfPreviewShell.setHtmlDownloadHandler(null)
    }
    ovfPreviewShell.setHtmlDownloadHandler(() => handleDownloadHtml())
    return () => ovfPreviewShell.setHtmlDownloadHandler(null)
  }, [embeddedInModal, ovfPreviewShell, showOvfHtmlDownload, handleDownloadHtml])

  function handleSaveSalesDraft() {
    if (!user || !quoteId || !ovfRef) return
    const fresh = getSavedQuoteById(quoteId)
    const merged = mergeOvfForAutosave(fresh?.ovf, ovfRef, fields, proofAttachments)
    const next = updateSavedQuoteOvf(quoteId, user.oid, {
      ...merged,
      workflowStatus: 'sales_draft',
    })
    if (next) setRecord(next)
    setShareNotice(
      'Draft saved. Submit to Finance when you are ready; your OVF stays on this quote.',
    )
    window.setTimeout(() => setShareNotice(null), 8000)
  }

  function handleSubmitToFinanceQueue() {
    if (!user || !quoteId || !data || !record?.ovf) return
    const fresh = getSavedQuoteById(quoteId)
    const coPo = trimmedOvfText(fields.companyPoNumber)
    const fieldsForSubmit =
      coPo === '' ? { ...fields, companyPoNumber: allocateNextCompanyPoNumber() } : fields
    if (coPo === '') setFields(fieldsForSubmit)
    const merged = mergeOvfForAutosave(
      fresh?.ovf,
      ovfRef,
      fieldsForSubmit,
      proofAttachments,
    )
    const next = updateSavedQuoteOvf(quoteId, user.oid, {
      ...merged,
      workflowStatus: 'pending_finance',
      submittedToFinanceAt: new Date().toISOString(),
      lastFinanceEmailTo: undefined,
      financeRejectionNote: undefined,
    })
    if (next) setRecord(next)
    setFinanceModalOpen(false)
    if (mode === 'sales') {
      navigate('/sales', { replace: true })
    } else {
      setShareNotice(
        'OVF submitted. Switch to the Finance workspace to review and approve or reject it.',
      )
      window.setTimeout(() => setShareNotice(null), 12000)
    }
  }

  function handleFinanceApprove() {
    if (!quoteId || !user || !record?.ovf) return
    const merged = mergeOvfForAutosave(record.ovf, ovfRef, fields)
    const next = updateSavedQuoteOvfByRecordId(quoteId, {
      ...merged,
      workflowStatus: 'finance_approved',
      financeApprovedBy: user.displayName || user.oid,
      financeApprovedByOid: user.oid,
      financeDecisionAt: new Date().toISOString(),
      financeRejectionNote: undefined,
    })
    if (!next) return
    setRecord(next)
    setShowRejectPanel(false)
    setRejectNote('')
      if (mode === 'finance') {
      navigate('/finance', { replace: true })
    }
  }

  function handleFinanceReject() {
    if (!quoteId || !user || !record?.ovf) return
    const note = rejectNote.trim()
    if (!note) {
      setShareNotice('Please add a short reason for rejection.')
      window.setTimeout(() => setShareNotice(null), 6000)
      return
    }
    const merged = mergeOvfForAutosave(record.ovf, ovfRef, fields)
    const next = updateSavedQuoteOvfByRecordId(quoteId, {
      ...merged,
      workflowStatus: 'finance_rejected',
      financeRejectionNote: note,
      financeDecisionAt: new Date().toISOString(),
      financeApprovedBy: undefined,
      financeApprovedByOid: undefined,
    })
    if (next) setRecord(next)
    setShowRejectPanel(false)
    setRejectNote('')
    setShareNotice('OVF sent back to Sales with your note.')
    window.setTimeout(() => setShareNotice(null), 8000)
  }

  if (!quoteId) {
    return (
      <Navigate
        to={mode === 'finance' ? '/finance' : mode === 'scm' ? '/scm' : '/sales'}
        replace
      />
    )
  }

  if (mode === 'sales' && !user) {
    return <Navigate to="/sales" replace />
  }

  if (record === undefined) {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  if (!record || isQuoteDraft(record)) {
    return (
      <Navigate
        to={mode === 'finance' ? '/finance' : mode === 'scm' ? '/scm' : '/sales'}
        replace
      />
    )
  }

  if (!record.ovf && (mode !== 'sales' || embeddedInModal)) {
    return (
      <Navigate
        to={mode === 'finance' ? '/finance' : mode === 'scm' ? '/scm' : '/sales'}
        replace
      />
    )
  }

  if (
    mode === 'sales' &&
    record &&
    !embeddedInModal &&
    !record.ovf &&
    ovfBootstrapBlock &&
    ovfReady
  ) {
    return (
      <section className="panel ovf-entry">
        <p className="panel__back">
          <Link to="/sales" className="link-back">
            ← Back to Sales
          </Link>
        </p>
        <h2 className="ovf-entry__title">OVF blocked</h2>
        <p className="form-validation-banner ovf-entry__banner ovf-entry__banner--reject" role="alert">
          {ovfBootstrapBlock}
        </p>
        <p className="muted">
          Manage the{' '}
          <Link className="link-back" to={`/sales/q/${quoteId}`}>
            customer PO
          </Link>{' '}
          from this quote first.
        </p>
      </section>
    )
  }

  if (mode === 'scm' && wf !== 'finance_approved') {
    return <Navigate to="/scm" replace />
  }

  if (mode === 'finance' && wf !== 'pending_finance' && wf !== 'finance_approved') {
    return <Navigate to="/finance" replace />
  }

  if (!data || !ovfReady || !record.ovf) {
    return (
      <div className="auth-loading muted" aria-busy="true">
        Loading…
      </div>
    )
  }

  const showPartyAiInlineNotice = ovfPartyAiHydrating

  function formatUnitInr(raw: string): string {
    const t = String(raw ?? '').trim()
    if (!t) return '—'
    return formatInr(Number.parseFloat(t.replace(/,/g, '')) || 0)
  }

  function renderChargesSimple(
    lines: QuoteLineForm[],
    section: 'all' | 'customer' | 'vendor' | 'margin' = 'all',
  ) {
    if (lines.length === 0) {
      return <p className="muted ovf-entry__line-items-empty">—</p>
    }
    const showCustomer = section === 'all' || section === 'customer'
    const showVendor = section === 'all' || section === 'vendor'
    const showMargin = section === 'all' || section === 'margin'
    const computed = lines.map((ln, i) => {
      const effectiveLine = effectiveOvfLine(ln)
      const base = lineAmount(effectiveLine)
      const gst = base * (gstRate / 100)
      const withGst = base + gst
      const unitRaw = String(fields.vendorPurchaseUnitByLineId[ln.id] ?? '')
      const eco = computeLineEconomics(effectiveLine, unitRaw)
      return { ln, base, gst, withGst, eco, i }
    })
    const sumBase = computed.reduce((s, r) => s + r.base, 0)
    const sumGst = computed.reduce((s, r) => s + r.gst, 0)
    const sumWith = computed.reduce((s, r) => s + r.withGst, 0)
    const vendorLinePurchaseSum = computed.reduce(
      (s, { eco }) => s + (eco.purchaseTotal ?? 0),
      0,
    )
    const freightInr = extraChargeInrFromField(
      fields.freightCharges,
      fields.freightChargesUnit,
      vendorLinePurchaseSum,
    )
    const financeInr = extraChargeInrFromField(
      fields.financeCost,
      fields.financeCostUnit,
      vendorLinePurchaseSum,
    )
    const productsMarginInr = sumBase - vendorLinePurchaseSum
    const productsMarginPct =
      sumBase > 0 ? (productsMarginInr / sumBase) * 100 : null
    const marginTotalInr = productsMarginInr - freightInr - financeInr
    const marginTotalPct = sumBase > 0 ? (marginTotalInr / sumBase) * 100 : null
    const showVendorTotals =
      aggEco.totalPurchase > 0 ||
      lines.some((ln) => String(vendorPurchaseMap[ln.id] ?? '').trim() !== '') ||
      trimmedOvfText(fields.freightCharges) ||
      trimmedOvfText(fields.financeCost)
    const includeVendorExtras = true
    const sumVendorPurchaseGst = computed.reduce((s, { eco }) => {
      const p = eco.purchaseTotal
      return s + (p != null ? p * (gstRate / 100) : 0)
    }, 0)
    const sumVendorPurchaseWithGst = computed.reduce((s, { eco }) => {
      const p = eco.purchaseTotal
      return s + (p != null ? p + p * (gstRate / 100) : 0)
    }, 0)
    const footerVendorLineTotal =
      vendorLinePurchaseSum +
      (includeVendorExtras ? freightInr + financeInr : 0)
    // Vendor GST is computed only from vendor line totals (qty × vendor unit).
    // Freight/finance roll into vendor total but do not affect GST.
    const footerVendorGst = sumVendorPurchaseGst
    const footerVendorWithGst =
      sumVendorPurchaseWithGst +
      (includeVendorExtras ? freightInr + financeInr : 0)

    const vendorUnitFieldsActive = salesCanEdit && mode === 'sales'

    return (
      <div className="ovf-entry__charges-tables">
        {showCustomer ? (
          <div className="ovf-entry__charges-table-block">
            <div className="ovf-entry__table-wrap ovf-entry__table-wrap--in-block">
              <table
                className="ovf-entry__table ovf-entry__table--charges"
                aria-label="Customer charges"
              >
                <thead>
                  <tr>
                    <th scope="col">S No.</th>
                    <th scope="col">Product</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="ovf-entry__num">
                      Qty
                    </th>
                    <th scope="col" className="ovf-entry__num">
                      Unit (INR)
                    </th>
                    <th scope="col" className="ovf-entry__num">
                      Total (INR)
                    </th>
                    <th scope="col" className="ovf-entry__num">
                      GST ({gstRate}%)
                    </th>
                    <th scope="col" className="ovf-entry__num">
                      With GST (INR)
                    </th>
                    {salesCanEdit ? <th scope="col">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {computed.map(({ ln, base, gst, withGst, i }) => {
                    const isEditing =
                      salesCanEdit && editingCustomerLineId === ln.id
                    const draft = isEditing ? editingCustomerLineDraft : null
                    return (
                      <tr key={ln.id}>
                        <td>{i + 1}</td>
                        <td>
                          {isEditing ? (
                            <input
                              type="text"
                              className="field__control ovf-entry__charges-edit-input"
                              value={draft?.product ?? ''}
                              onChange={(e) =>
                                setEditingCustomerLineDraft((p) =>
                                  p ? { ...p, product: e.target.value } : p,
                                )
                              }
                              aria-label="Edit product"
                            />
                          ) : (
                            (ln.product || '').trim() || '—'
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              type="text"
                              className="field__control ovf-entry__charges-edit-input"
                              value={draft?.description ?? ''}
                              onChange={(e) =>
                                setEditingCustomerLineDraft((p) =>
                                  p
                                    ? { ...p, description: e.target.value }
                                    : p,
                                )
                              }
                              aria-label="Edit description"
                            />
                          ) : (
                            (ln.description || '').trim() || '—'
                          )}
                        </td>
                        <td className="ovf-entry__num">
                          {isEditing ? (
                            <input
                              type="text"
                              className="field__control ovf-entry__charges-edit-input ovf-entry__charges-edit-input--num"
                              value={draft?.qty ?? ''}
                              onChange={(e) =>
                                setEditingCustomerLineDraft((p) =>
                                  p ? { ...p, qty: e.target.value } : p,
                                )
                              }
                              aria-label="Edit quantity"
                            />
                          ) : (
                            ln.qty || '—'
                          )}
                        </td>
                        <td className="ovf-entry__num">
                          {isEditing ? (
                            <input
                              type="text"
                              className="field__control ovf-entry__charges-edit-input ovf-entry__charges-edit-input--num"
                              value={draft?.unitPrice ?? ''}
                              onChange={(e) =>
                                setEditingCustomerLineDraft((p) =>
                                  p
                                    ? { ...p, unitPrice: e.target.value }
                                    : p,
                                )
                              }
                              aria-label="Edit unit INR"
                            />
                          ) : (
                            formatUnitInr(ln.unitPrice)
                          )}
                        </td>
                        <td className="ovf-entry__num">{formatInr(base)}</td>
                        <td className="ovf-entry__num">{formatInr(gst)}</td>
                        <td className="ovf-entry__num">{formatInr(withGst)}</td>
                        {salesCanEdit ? (
                          <td>
                            {isEditing ? (
                              <div className="ovf-entry__row-actions">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact"
                                  onClick={() => {
                                    if (!editingCustomerLineDraft) return
                                    const d = editingCustomerLineDraft
                                    persistQuoteLines((lines) =>
                                      lines.map((x) =>
                                        x.id === ln.id
                                          ? {
                                              ...x,
                                              product: d.product,
                                              description: d.description,
                                              qty: d.qty,
                                              unitPrice: d.unitPrice,
                                            }
                                          : x,
                                      ),
                                    )
                                    setEditingCustomerLineId(null)
                                    setEditingCustomerLineDraft(null)
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact"
                                  onClick={() => {
                                    setEditingCustomerLineId(null)
                                    setEditingCustomerLineDraft(null)
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="ovf-entry__row-actions">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact"
                                  onClick={() => {
                                    setEditingCustomerLineId(ln.id)
                                    setEditingCustomerLineDraft({ ...ln })
                                  }}
                                  aria-label="Edit line"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn--compact"
                                  onClick={() => {
                                    persistQuoteLines((lines) => {
                                      const next = lines.filter(
                                        (x) => x.id !== ln.id,
                                      )
                                      return next.length > 0
                                        ? next
                                        : [createEmptyLine()]
                                    })
                                    if (editingCustomerLineId === ln.id) {
                                      setEditingCustomerLineId(null)
                                      setEditingCustomerLineDraft(null)
                                    }
                                  }}
                                  aria-label="Remove line"
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="ovf-entry__charges-tfoot-row">
                    <td
                      /* Span up to (and including) Unit column so totals align under Total/GST/With GST. */
                      colSpan={5}
                      className="ovf-entry__charges-tfoot-label"
                    >
                      Customer totals
                    </td>
                    <td className="ovf-entry__num">{formatInr(sumBase)}</td>
                    <td className="ovf-entry__num">{formatInr(sumGst)}</td>
                    <td className="ovf-entry__num">{formatInr(sumWith)}</td>
                    {salesCanEdit ? <td /> : null}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : null}

        {showVendor ? (
        <div className="ovf-entry__customer-details-wrap">
          <h3
            className="ovf-entry__customer-details-heading"
            id={`${quoteId}-ovf-vendor-purchase-heading`}
          >
            Vendor purchase
          </h3>
          <fieldset
            className="ovf-entry__fieldset ovf-entry__fieldset--details-strong"
            aria-labelledby={`${quoteId}-ovf-vendor-purchase-heading`}
          >
            {salesCanEdit ? (
              <div className="ovf-entry__blocks ovf-entry__blocks--2 ovf-entry__blocks--no-stack">
                {renderFreightFinanceEditors({ showFreight: true, showFinance: true })}
              </div>
            ) : null}
            <div className="ovf-entry__table-wrap ovf-entry__table-wrap--in-block">
              <table className="ovf-entry__table ovf-entry__table--charges">
              <thead>
                <tr>
                  <th scope="col">S No.</th>
                  <th scope="col">Product</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="ovf-entry__num">
                    Qty
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    Unit (INR)
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    Total (INR)
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    GST ({gstRate}%)
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    With GST (INR)
                  </th>
                  {salesCanEdit ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {computed.map(({ ln, eco, i }) => {
                  const purchase = eco.purchaseTotal
                  const purchaseGst =
                    purchase != null ? purchase * (gstRate / 100) : null
                  const purchaseWithGst =
                    purchase != null
                      ? purchase + purchase * (gstRate / 100)
                      : null
                  const unitRaw = String(
                    fields.vendorPurchaseUnitByLineId[ln.id] ?? '',
                  )
                  return (
                  <tr key={`v-${ln.id}`}>
                    <td>{i + 1}</td>
                    <td>
                      {(ln.product || '').trim() || '—'}
                    </td>
                    <td>
                      {(ln.description || '').trim() || '—'}
                    </td>
                    <td className="ovf-entry__num">
                      {ln.qty || '—'}
                    </td>
                    <td className="ovf-entry__num ovf-entry__num--field">
                      {vendorUnitFieldsActive ? (
                        <input
                          type="text"
                          className="field__control ovf-entry__vendor-unit-input"
                          inputMode="decimal"
                          value={unitRaw}
                          onChange={(e) =>
                            patchVendorPurchaseUnit(ln.id, e.target.value)
                          }
                          aria-label={`Vendor unit (INR) for ${(ln.product || '').trim() || 'line'}`}
                        />
                      ) : eco.vendorUnitDisplay.trim() ? (
                        formatUnitInr(eco.vendorUnitDisplay)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="ovf-entry__num ovf-entry__num--field">
                      {vendorUnitFieldsActive ? (
                        <span
                          className="ovf-entry__vendor-derived-text"
                          aria-label="Vendor line total (INR), from qty × unit"
                          title="Vendor line total (INR), from qty × unit"
                        >
                          {purchase != null ? formatInr(purchase) : '—'}
                        </span>
                      ) : purchase != null ? (
                        formatInr(purchase)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="ovf-entry__num ovf-entry__num--field">
                      {vendorUnitFieldsActive ? (
                        <span
                          className="ovf-entry__vendor-derived-text"
                          aria-label={`GST on vendor line (${gstRate}%)`}
                          title={`GST on vendor line (${gstRate}%)`}
                        >
                          {purchaseGst != null ? formatInr(purchaseGst) : '—'}
                        </span>
                      ) : purchaseGst != null ? (
                        formatInr(purchaseGst)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="ovf-entry__num ovf-entry__num--field">
                      {vendorUnitFieldsActive ? (
                        <span
                          className="ovf-entry__vendor-derived-text"
                          aria-label="Vendor line with GST (INR)"
                          title="Vendor line with GST (INR)"
                        >
                          {purchaseWithGst != null ? formatInr(purchaseWithGst) : '—'}
                        </span>
                      ) : purchaseWithGst != null ? (
                        formatInr(purchaseWithGst)
                      ) : (
                        '—'
                      )}
                    </td>
                    {salesCanEdit ? (
                      <td>
                        <div className="ovf-entry__row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn--compact"
                            onClick={() => {
                              persistQuoteLines((lines) => {
                                const next = lines.filter((x) => x.id !== ln.id)
                                return next.length > 0 ? next : [createEmptyLine()]
                              })
                              setFields((p) => {
                                const next = { ...(p.vendorPurchaseUnitByLineId ?? {}) }
                                delete next[ln.id]
                                return { ...p, vendorPurchaseUnitByLineId: next }
                              })
                            }}
                            aria-label="Remove line"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="ovf-entry__charges-tfoot-row">
                  <td colSpan={5} className="ovf-entry__charges-tfoot-label">
                    Vendor totals
                  </td>
                  <td className="ovf-entry__num">
                    {showVendorTotals || footerVendorLineTotal > 0
                      ? formatInr(footerVendorLineTotal)
                      : '—'}
                  </td>
                  <td className="ovf-entry__num">
                    {showVendorTotals || footerVendorGst > 0
                      ? formatInr(footerVendorGst)
                      : '—'}
                  </td>
                  <td className="ovf-entry__num">
                    {showVendorTotals || footerVendorWithGst > 0
                      ? formatInr(footerVendorWithGst)
                      : '—'}
                  </td>
                  {salesCanEdit ? <td /> : null}
                </tr>
              </tfoot>
            </table>
          </div>
          {salesCanEdit ? (
            <div className="ovf-entry__vendor-custom-save">
              <button
                type="button"
                className="btn btn-ghost btn--compact"
                onClick={() => persistQuoteLines((lines) => [...lines, createEmptyLine()])}
              >
                Add line
              </button>
            </div>
          ) : null}
          </fieldset>
        </div>
        ) : null}

        {showMargin ? (
        <div className="ovf-entry__customer-details-wrap">
          <h3
            className="ovf-entry__customer-details-heading"
            id={`${quoteId}-ovf-margin-heading`}
          >
            Margin
          </h3>
          <fieldset
            className="ovf-entry__fieldset ovf-entry__fieldset--details-strong"
            aria-labelledby={`${quoteId}-ovf-margin-heading`}
          >
            <div className="ovf-entry__table-wrap ovf-entry__table-wrap--in-block">
              <table className="ovf-entry__table ovf-entry__table--charges">
              <thead>
                <tr>
                  <th scope="col">S No.</th>
                  <th scope="col">Product</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="ovf-entry__num">
                    Qty
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    Margin (INR)
                  </th>
                  <th scope="col" className="ovf-entry__num">
                    Margin %
                  </th>
                </tr>
              </thead>
              <tbody>
                {computed.map(({ ln, eco, i }) => (
                  <tr key={`m-${ln.id}`}>
                    <td>{i + 1}</td>
                    <td>{(ln.product || '').trim() || '—'}</td>
                    <td>{(ln.description || '').trim() || '—'}</td>
                    <td className="ovf-entry__num">{ln.qty || '—'}</td>
                    <td className="ovf-entry__num">
                      {eco.marginInr != null ? formatInr(eco.marginInr) : '—'}
                    </td>
                    <td className="ovf-entry__num">
                      {eco.marginPctOnSale != null
                        ? `${eco.marginPctOnSale.toFixed(2)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {showVendorTotals && (freightInr > 0 || financeInr > 0) ? (
                  <>
                    <tr className="ovf-entry__charges-tfoot-row">
                      <td colSpan={4} className="ovf-entry__charges-tfoot-label">
                        Products margin
                      </td>
                      <td className="ovf-entry__num">
                        {formatInr(productsMarginInr)}
                      </td>
                      <td className="ovf-entry__num">
                        {productsMarginPct != null
                          ? `${productsMarginPct.toFixed(2)}%`
                          : '—'}
                      </td>
                    </tr>
                    {freightInr > 0 ? (
                      <tr className="ovf-entry__charges-tfoot-row">
                        <td colSpan={4} className="ovf-entry__charges-tfoot-label">
                          Less: Freight charges
                        </td>
                        <td className="ovf-entry__num">{formatInr(-freightInr)}</td>
                        <td className="ovf-entry__num">—</td>
                      </tr>
                    ) : null}
                    {financeInr > 0 ? (
                      <tr className="ovf-entry__charges-tfoot-row">
                        <td colSpan={4} className="ovf-entry__charges-tfoot-label">
                          Less: Finance cost
                        </td>
                        <td className="ovf-entry__num">{formatInr(-financeInr)}</td>
                        <td className="ovf-entry__num">—</td>
                      </tr>
                    ) : null}
                  </>
                ) : null}
                <tr className="ovf-entry__charges-tfoot-row">
                  <td colSpan={4} className="ovf-entry__charges-tfoot-label">
                    Margin totals
                  </td>
                  <td className="ovf-entry__num">
                    {showVendorTotals ? formatInr(marginTotalInr) : '—'}
                  </td>
                  <td className="ovf-entry__num">
                    {showVendorTotals && marginTotalPct != null
                      ? `${marginTotalPct.toFixed(2)}%`
                      : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          </fieldset>
        </div>
        ) : null}
      </div>
    )
  }

  function renderFreightFinanceEditors(opts: {
    showFreight: boolean
    showFinance: boolean
  }) {
    const ro = freightFinanceReadOnly
    return (
      <>
        {opts.showFreight ? (
          <div className="ovf-entry__block">
            <span className="ovf-entry__block-label" id={`${quoteId}-freight-label`}>
              Freight charges
            </span>
            <div
              className="ovf-entry__money-with-unit"
              role="group"
              aria-labelledby={`${quoteId}-freight-label`}
            >
              <input
                type="text"
                className="field__control ovf-entry__money-input"
                inputMode="decimal"
                value={fields.freightCharges}
                onChange={(e) => patchField('freightCharges', e.target.value)}
                readOnly={ro}
              />
              {ro ? (
                <span className="field__control ovf-entry__readonly ovf-entry__money-unit-display">
                  {fields.freightChargesUnit === 'percent' ? '%' : 'INR'}
                </span>
              ) : (
                <select
                  className="field__control ovf-entry__money-unit"
                  value={fields.freightChargesUnit}
                  onChange={(e) =>
                    patchField('freightChargesUnit', e.target.value as OvfMoneyUnit)
                  }
                  aria-label="Freight amount unit"
                >
                  <option value="inr">INR</option>
                  <option value="percent">%</option>
                </select>
              )}
            </div>
          </div>
        ) : null}
        {opts.showFinance ? (
          <div className="ovf-entry__block">
            <span className="ovf-entry__block-label" id={`${quoteId}-finance-label`}>
              Finance cost
            </span>
            <div
              className="ovf-entry__money-with-unit"
              role="group"
              aria-labelledby={`${quoteId}-finance-label`}
            >
              <input
                type="text"
                className="field__control ovf-entry__money-input"
                inputMode="decimal"
                value={fields.financeCost}
                onChange={(e) => patchField('financeCost', e.target.value)}
                readOnly={ro}
              />
              {ro ? (
                <span className="field__control ovf-entry__readonly ovf-entry__money-unit-display">
                  {fields.financeCostUnit === 'percent' ? '%' : 'INR'}
                </span>
              ) : (
                <select
                  className="field__control ovf-entry__money-unit"
                  value={fields.financeCostUnit}
                  onChange={(e) =>
                    patchField('financeCostUnit', e.target.value as OvfMoneyUnit)
                  }
                  aria-label="Finance cost unit"
                >
                  <option value="inr">INR</option>
                  <option value="percent">%</option>
                </select>
              )}
            </div>
          </div>
        ) : null}
      </>
    )
  }

  const financeWatchForm = readOnly && mode === 'finance'
  const salesPreviewForm = viewOnlySales && mode === 'sales'
  const watchStyleForm = financeWatchForm || salesPreviewForm

  return (
    <section
      className={[
        'panel',
        'ovf-entry-page',
        watchStyleForm ? 'ovf-entry-page--watch-form' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={
        financeWatchForm
          ? 'Order verification form, read-only for Finance review'
          : salesPreviewForm
            ? 'Order verification form, read-only preview'
            : undefined
      }
    >
      {ovfPartyAiOverlayVisible ? (
        <div className="ovf-entry__party-ai-overlay" aria-hidden="true">
          <div className="ovf-entry__party-ai-overlay-card">
            <div className="ovf-entry__party-ai-spinner" aria-hidden="true" />
            <div className="ovf-entry__party-ai-overlay-title">
              Filling details from attachments…
            </div>
            <div className="muted ovf-entry__party-ai-overlay-sub">
              This should finish quickly.
            </div>
          </div>
        </div>
      ) : null}

      {!embeddedInModal ? (
        <div className="panel__back ovf-entry__back-row">
          <Link
            to={
              mode === 'sales'
                ? '/sales'
                : mode === 'finance'
                  ? financeBackTo
                  : '/scm'
            }
            className={
              mode === 'sales'
                ? 'link-back'
                : 'btn btn-ghost ovf-entry__back-btn'
            }
          >
            <span className="ovf-entry__back-arrow" aria-hidden>
              ←
            </span>
            <span>
              {mode === 'sales'
                ? 'Back to quotes'
                : mode === 'finance'
                  ? financeBackTo.includes('/workflow')
                    ? 'Back to quote workflow'
                    : 'Finance workspace'
                  : 'SCM workspace'}
            </span>
          </Link>
        </div>
      ) : null}

      {salesPreviewForm && quoteId ? (
        <p className="ovf-entry__view-preview-banner muted" role="status">
          {wf === 'sales_draft' || wf === 'finance_rejected' ? (
            <>
              Read-only preview.{' '}
              {embeddedInModal ? (
                <a href={`/sales/q/${quoteId}/ovf`} className="link-back">
                  Edit OVF
                </a>
              ) : (
                <Link to={`/sales/q/${quoteId}/ovf`}>Edit OVF</Link>
              )}
            </>
          ) : (
            'Read-only preview.'
          )}
        </p>
      ) : null}

      {mode === 'scm' && scmOverview ? (
        <section className="ovf-scm-overview" aria-label="SCM summary">
          <div className="ovf-scm-overview__header">
            <h3 className="ovf-scm-overview__title">OVF overview (for PO)</h3>
            {scmOvfHtmlDownloadInOverview ? (
              <button
                type="button"
                className="btn btn-ghost ovf-entry__download-icon-btn"
                title="Download OVF (HTML)"
                aria-label="Download OVF (HTML)"
                onClick={() => handleDownloadHtml()}
              >
                <OvfDownloadIcon />
              </button>
            ) : null}
          </div>
          <div className="ovf-scm-overview__grid">
            <div>
              <span className="ovf-scm-overview__k">OVF number</span>
              <p className="ovf-scm-overview__v scm-ovf-ref">{scmOverview.ovfRef}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Quote number</span>
              <p className="ovf-scm-overview__v">{scmOverview.quoteRef}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Customer</span>
              <p className="ovf-scm-overview__v">{scmOverview.customerName}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Approval status</span>
              <p className="ovf-scm-overview__v">{scmOverview.workflowLabel}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Approved by</span>
              <p className="ovf-scm-overview__v">{scmOverview.approvedBy}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Vendor</span>
              <p className="ovf-scm-overview__v">{scmOverview.vendorName}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Margin (total)</span>
              <p className="ovf-scm-overview__v">{scmOverview.marginAmount}</p>
            </div>
            <div>
              <span className="ovf-scm-overview__k">Margin %</span>
              <p className="ovf-scm-overview__v">{scmOverview.marginPercent}</p>
            </div>
          </div>
          <div className="ovf-scm-overview__products">
            <span className="ovf-scm-overview__k">Products</span>
            <ul className="ovf-scm-overview__product-list">
              {scmOverview.productLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="ovf-scm-overview__po-cta">
            <Link
              to={`/scm/q/${quoteId}/po`}
              className="btn btn-primary btn--compact"
            >
              {record.scmPo ? 'Open purchase order' : 'Create purchase order'}
            </Link>
          </p>
        </section>
      ) : null}

      {scmCanEditFreightFinance ? (
        <p className="ovf-entry__banner ovf-entry__banner--info" role="status">
          Edit <strong>freight</strong> and <strong>finance</strong> in <strong>Freight &amp; finance (SCM)</strong>{' '}
          below (the Vendor purchase table is read-only here). Values stay in sync with that table.
          Changes save automatically after a short pause.
          {scmCanEditCompanyPo ? (
            <>
              {' '}
              You can also correct <strong>Company PO number</strong> in <strong>Company PO (SCM)</strong> below.
            </>
          ) : null}
        </p>
      ) : scmCanEditCompanyPo ? (
        <p className="ovf-entry__banner ovf-entry__banner--info" role="status">
          <strong>Company PO number</strong> was assigned when Sales sent this to Finance. Edit it in{' '}
          <strong>Company PO (SCM)</strong> below if needed; changes save automatically after a short pause.
        </p>
      ) : null}

      {mode === 'sales' && wf === 'pending_finance' ? (
        <p className="ovf-entry__banner ovf-entry__banner--pending" role="status">
          Submitted to Finance (editing locked). After Finance approves, SCM can create the PO from the SCM
          workspace.
        </p>
      ) : null}
      {mode === 'sales' && wf === 'finance_rejected' ? (
        <div className="ovf-entry__banner ovf-entry__banner--reject" role="status">
          <p>Returned by Finance — edit and resubmit.</p>
          {record.ovf.financeRejectionNote ? (
            <blockquote className="ovf-entry__reject-note">
              {record.ovf.financeRejectionNote}
            </blockquote>
          ) : null}
        </div>
      ) : null}
      {mode === 'sales' && wf === 'finance_approved' ? (
        <p className="ovf-entry__banner ovf-entry__banner--ok" role="status">
          Finance approved — SCM can create the purchase order from their workspace.
        </p>
      ) : null}
      {mode === 'finance' && wf === 'finance_approved' ? (
        <p className="ovf-entry__banner ovf-entry__banner--ok" role="status">
          This OVF was approved
          {record.ovf.financeDecisionAt
            ? ` on ${new Date(record.ovf.financeDecisionAt).toLocaleString()}`
            : ''}{' '}
          {record.ovf.financeApprovedBy ? `by ${record.ovf.financeApprovedBy}.` : null}
        </p>
      ) : null}

      {showPartyAiInlineNotice ? (
        <p className="ovf-entry__banner ovf-entry__banner--info" role="status">
          Enriching party fields from attachment text…{' '}
          <span className="muted">
            Uses rules + optional AI on your PO and invoice. Scanned/image-only PDFs often yield few
            fields — enter missing PO #, email, and vendor details manually if needed.
          </span>
        </p>
      ) : null}

      <h2 className="ovf-entry__title">OVF</h2>

      {/* Wrapper must be closed before actions/modals (same div below after last form fieldset). */}
      <div
        className={`ovf-entry__inert-shell${watchStyleForm ? ' ovf-entry__inert-shell--watch-form' : ''}`}
        inert={readOnly ? true : undefined}
      >
      <fieldset className="ovf-entry__fieldset ovf-entry__fieldset--details-strong">
        <legend className="ovf-entry__legend">Identification</legend>
        <div className="ovf-entry__blocks ovf-entry__blocks--2">
          <label className="ovf-entry__block">
            <span className="ovf-entry__block-label">OVF number</span>
            <input
              type="text"
              className="field__control"
              value={ovfRef}
              readOnly
              aria-readonly="true"
            />
          </label>
          {showOvfTextField(readOnly, fields.quoteNumber) ? (
            <label className="ovf-entry__block">
              <span className="ovf-entry__block-label">Quote number</span>
              <input
                type="text"
                className="field__control"
                value={fields.quoteNumber}
                onChange={(e) => patchField('quoteNumber', e.target.value)}
                aria-label="Quote number"
              />
            </label>
          ) : null}
          {showOvfTextField(readOnly, fields.ovfModuleOwner) ? (
            <label className="ovf-entry__block">
              <span className="ovf-entry__block-label">OVF module owner</span>
              <input
                type="text"
                className="field__control"
                value={fields.ovfModuleOwner}
                onChange={(e) => patchField('ovfModuleOwner', e.target.value)}
              />
            </label>
          ) : null}
          {wf !== 'sales_draft' ? (
            <label
              className={`ovf-entry__block${
                showOvfTextField(readOnly, fields.quoteNumber) ||
                showOvfTextField(readOnly, fields.ovfModuleOwner)
                  ? ' ovf-entry__block--full'
                  : ''
              }`}
            >
              <span className="ovf-entry__block-label">Company PO number</span>
              <input
                type="text"
                className="field__control"
                value={fields.companyPoNumber}
                readOnly
                title="Internal company PO; SCM can edit from Company PO (SCM) below."
                aria-readonly="true"
              />
            </label>
          ) : null}
        </div>
      </fieldset>

      {(showOvfTextField(readOnly, fields.customerName) ||
        showOvfTextField(readOnly, fields.contactPerson) ||
        showOvfTextField(readOnly, fields.customerPoNumber) ||
        showOvfTextField(readOnly, fields.shippingAddress) ||
        showOvfTextField(readOnly, fields.billingAddress) ||
        showOvfTextField(readOnly, fields.billingState) ||
        showOvfTextField(readOnly, fields.shippingState) ||
        showOvfTextField(readOnly, fields.contactNumber) ||
        showOvfTextField(readOnly, fields.contactEmail) ||
        showOvfTextField(readOnly, fields.customerPaymentTerms)) ? (
        <div className="ovf-entry__customer-details-wrap">
          <h3
            id="ovf-customer-details-heading"
            className="ovf-entry__customer-details-heading"
          >
            Customer details
          </h3>
          <fieldset
            className="ovf-entry__fieldset ovf-entry__fieldset--details-strong"
            aria-labelledby="ovf-customer-details-heading"
          >
            <div className="ovf-entry__blocks ovf-entry__blocks--2">
              {showOvfTextField(readOnly, fields.customerName) ? (
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">
                    Customer (company name)
                  </span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.customerName}
                    onChange={(e) => patchField('customerName', e.target.value)}
                  />
                </label>
              ) : null}
              {showOvfTextField(readOnly, fields.contactPerson) ? (
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">
                    Recipient / contact (individual)
                  </span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.contactPerson}
                    onChange={(e) => patchField('contactPerson', e.target.value)}
                  />
                </label>
              ) : null}
              {showOvfTextField(readOnly, fields.customerPoNumber) ? (
                <label
                  className={`ovf-entry__block${
                    !showOvfTextField(readOnly, fields.contactEmail)
                      ? ' ovf-entry__block--full'
                      : ''
                  }`}
                >
                  <span className="ovf-entry__block-label">Customer PO number</span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.customerPoNumber}
                    onChange={(e) => patchField('customerPoNumber', e.target.value)}
                    aria-label="Customer PO number"
                  />
                </label>
              ) : null}
              {showOvfTextField(readOnly, fields.contactEmail) ? (
                <label
                  className={`ovf-entry__block${
                    !showOvfTextField(readOnly, fields.customerPoNumber)
                      ? ' ovf-entry__block--full'
                      : ''
                  }`}
                >
                  <span className="ovf-entry__block-label">Email</span>
                  <input
                    type="email"
                    className="field__control"
                    value={fields.contactEmail}
                    onChange={(e) => patchField('contactEmail', e.target.value)}
                    autoComplete="email"
                  />
                </label>
              ) : null}
              {(showOvfTextField(readOnly, fields.billingAddress) ||
                showOvfTextField(readOnly, fields.billingState)) ? (
                <div
                  className={`ovf-entry__address-column${
                    !showOvfTextField(readOnly, fields.shippingAddress) &&
                    !showOvfTextField(readOnly, fields.shippingState)
                      ? ' ovf-entry__address-column--full'
                      : ''
                  }`}
                >
                  {showOvfTextField(readOnly, fields.billingAddress) ? (
                    <label className="ovf-entry__block">
                      <span className="ovf-entry__block-label">Billing address</span>
                      <OvfAutoTextarea
                        className="field__control ovf-entry__textarea"
                        minRows={4}
                        value={fields.billingAddress}
                        onChange={(v) => patchField('billingAddress', v)}
                      />
                    </label>
                  ) : null}
                  {showOvfTextField(readOnly, fields.billingState) ? (
                    <label className="ovf-entry__block">
                      <span className="ovf-entry__block-label">Billing state</span>
                      <input
                        type="text"
                        className="field__control"
                        value={fields.billingState}
                        onChange={(e) => patchField('billingState', e.target.value)}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {(showOvfTextField(readOnly, fields.shippingAddress) ||
                showOvfTextField(readOnly, fields.shippingState)) ? (
                <div
                  className={`ovf-entry__address-column${
                    !showOvfTextField(readOnly, fields.billingAddress) &&
                    !showOvfTextField(readOnly, fields.billingState)
                      ? ' ovf-entry__address-column--full'
                      : ''
                  }`}
                >
                  {showOvfTextField(readOnly, fields.shippingAddress) ? (
                    <label className="ovf-entry__block">
                      <span className="ovf-entry__block-label">Shipping address</span>
                      <OvfAutoTextarea
                        className="field__control ovf-entry__textarea"
                        minRows={4}
                        value={fields.shippingAddress}
                        onChange={(v) => patchField('shippingAddress', v)}
                        aria-label="Shipping address"
                      />
                    </label>
                  ) : null}
                  {showOvfTextField(readOnly, fields.shippingState) ? (
                    <label className="ovf-entry__block">
                      <span className="ovf-entry__block-label">Shipping state</span>
                      <input
                        type="text"
                        className="field__control"
                        value={fields.shippingState}
                        onChange={(e) => patchField('shippingState', e.target.value)}
                        aria-label="Shipping state"
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {showOvfTextField(readOnly, fields.contactNumber) ? (
                <label
                  className={`ovf-entry__block${
                    !showOvfTextField(readOnly, fields.customerPaymentTerms)
                      ? ' ovf-entry__block--full'
                      : ''
                  }`}
                >
                  <span className="ovf-entry__block-label">Contact no.</span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.contactNumber}
                    onChange={(e) => patchField('contactNumber', e.target.value)}
                  />
                </label>
              ) : null}
              {showOvfTextField(readOnly, fields.customerPaymentTerms) ? (
                <label
                  className={`ovf-entry__block${
                    !showOvfTextField(readOnly, fields.contactNumber)
                      ? ' ovf-entry__block--full'
                      : ''
                  }`}
                >
                  <span className="ovf-entry__block-label">Payment terms</span>
                  <select
                    className="field__control ovf-entry__vendor-terms-preset"
                    aria-label="Customer payment terms"
                    value={
                      customerPaymentTermsPresetValue === 'manual'
                        ? '__saved__'
                        : customerPaymentTermsPresetValue
                    }
                    onChange={(e) => {
                      const v = e.target.value
                      if (
                        (OVF_VENDOR_PAYMENT_PRESET_DAYS as readonly string[]).includes(v)
                      ) {
                        patchField('customerPaymentTerms', `${v} days`)
                      }
                    }}
                  >
                    {customerPaymentTermsHasSavedCustom ? (
                      <option value="__saved__">
                        {fields.customerPaymentTerms.trim()} (saved)
                      </option>
                    ) : null}
                    {OVF_VENDOR_PAYMENT_PRESET_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </fieldset>
        </div>
      ) : null}

      {(!readOnly ||
        trimmedOvfText(fields.vendorName) ||
        trimmedOvfText(fields.vendorContactNumber) ||
        trimmedOvfText(fields.vendorEmailId)) ? (
        <div className="ovf-entry__customer-details-wrap">
          <h3
            id="ovf-vendor-details-heading"
            className="ovf-entry__customer-details-heading"
          >
            Vendor details
          </h3>
          <fieldset
            className="ovf-entry__fieldset ovf-entry__fieldset--details-strong"
            aria-labelledby="ovf-vendor-details-heading"
          >
          {readOnly || mode !== 'sales' ? (
            trimmedOvfText(fields.vendorPoNumber) ||
            trimmedOvfText(fields.vendorName) ||
            trimmedOvfText(fields.vendorContactNumber) ||
            trimmedOvfText(fields.vendorEmailId) ? (
              <div className="ovf-entry__vendor-summary ovf-entry__block ovf-entry__block--full">
                <span className="ovf-entry__block-label">Vendor</span>
                {trimmedOvfText(fields.vendorPoNumber) ? (
                  <p className="ovf-entry__vendor-summary-name">
                    PO: {fields.vendorPoNumber.trim()}
                  </p>
                ) : null}
                {trimmedOvfText(fields.vendorName) ? (
                  <p className="ovf-entry__vendor-summary-name">{fields.vendorName.trim()}</p>
                ) : null}
                {trimmedOvfText(fields.vendorContactNumber) ? (
                  <div className="ovf-entry__vendor-addr-display">
                    Contact: {fields.vendorContactNumber.trim()}
                  </div>
                ) : null}
                {trimmedOvfText(fields.vendorEmailId) ? (
                  <div className="ovf-entry__vendor-addr-display">
                    Email: {fields.vendorEmailId.trim()}
                  </div>
                ) : null}
                {trimmedOvfText(fields.vendorPaymentTerms) ? (
                  <div className="ovf-entry__vendor-addr-display">
                    Payment terms: {fields.vendorPaymentTerms.trim()}
                  </div>
                ) : null}
              </div>
            ) : null
          ) : (
            <div className="ovf-entry__vendor-custom">
              <div className="ovf-entry__blocks ovf-entry__blocks--2">
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">Vendor name</span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.vendorName}
                    onChange={(e) => patchField('vendorName', e.target.value)}
                  />
                </label>
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">Vendor PO number</span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.vendorPoNumber}
                    onChange={(e) => patchField('vendorPoNumber', e.target.value)}
                  />
                </label>
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">Contact number</span>
                  <input
                    type="text"
                    className="field__control"
                    value={fields.vendorContactNumber}
                    onChange={(e) => patchField('vendorContactNumber', e.target.value)}
                  />
                </label>
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">Email ID</span>
                  <input
                    type="email"
                    className="field__control"
                    value={fields.vendorEmailId}
                    onChange={(e) => patchField('vendorEmailId', e.target.value)}
                    autoComplete="email"
                  />
                </label>
                <label className="ovf-entry__block">
                  <span className="ovf-entry__block-label">Vendor payment terms</span>
                  <select
                    className="field__control ovf-entry__vendor-terms-preset"
                    aria-label="Vendor payment terms"
                    value={vendorPaymentTermsPresetSelectValue(fields.vendorPaymentTerms)}
                    onChange={(e) => {
                      const v = e.target.value
                      if (
                        (OVF_VENDOR_PAYMENT_PRESET_DAYS as readonly string[]).includes(v)
                      ) {
                        patchField('vendorPaymentTerms', `${v} days`)
                      }
                    }}
                  >
                    {OVF_VENDOR_PAYMENT_PRESET_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )}
          </fieldset>
        </div>
      ) : null}

      <div className="ovf-entry__customer-details-wrap">
        <h3
          className="ovf-entry__customer-details-heading"
          id={`${quoteId}-ovf-customer-charges-heading`}
        >
          Customer charges
        </h3>
        <fieldset
          className="ovf-entry__fieldset ovf-entry__fieldset--details-strong"
          aria-labelledby={`${quoteId}-ovf-customer-charges-heading`}
        >
          <div className="ovf-entry__blocks ovf-entry__blocks--3 ovf-entry__blocks--no-stack-3">
            {showOvfTextField(readOnly, fields.gstPercent) ? (
              <label className="ovf-entry__block">
                <span className="ovf-entry__block-label">GST % (on line totals)</span>
                {readOnly ? (
                  <span className="field__control ovf-entry__gst-input ovf-entry__readonly">
                    {trimmedOvfText(fields.gstPercent) || '18'}%
                  </span>
                ) : (
                  <select
                    className="field__control ovf-entry__gst-input"
                    value={gstPercentSelectValue}
                    onChange={(e) => patchField('gstPercent', e.target.value)}
                    aria-label="GST percent on line totals"
                  >
                    {gstPercentNeedsSavedOption ? (
                      <option value={gstPercentSelectValue}>
                        {gstPercentSelectValue}% (saved)
                      </option>
                    ) : null}
                    {OVF_GST_PERCENT_PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {p}%
                      </option>
                    ))}
                  </select>
                )}
              </label>
            ) : (
              <div className="ovf-entry__block" aria-hidden />
            )}
            <div className="ovf-entry__block" aria-hidden />
            <div className="ovf-entry__block" aria-hidden />
          </div>
          {renderChargesSimple(commercial, 'customer')}
        </fieldset>
      </div>

      {renderChargesSimple(commercial, 'vendor')}
      {renderChargesSimple(commercial, 'margin')}

      </div>{/* ovf-entry__inert-shell */}

      {scmCanEditCompanyPo ? (
        <fieldset className="ovf-entry__fieldset ovf-entry__fieldset--scm-freight-finance">
          <legend className="ovf-entry__legend">Company PO (SCM)</legend>
          <p className="muted ovf-entry__intro ovf-entry__intro--tight">
            Internal reference (e.g. <strong>PO/25-26/001</strong>). Sequences by financial year (Apr–Mar).
            Sales cannot change this here; Finance sees it read-only.
          </p>
          <div className="ovf-entry__blocks ovf-entry__blocks--2">
            <label className="ovf-entry__block">
              <span className="ovf-entry__block-label">Company PO number</span>
              <input
                type="text"
                className="field__control"
                value={fields.companyPoNumber}
                onChange={(e) => patchField('companyPoNumber', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label="Company PO number (SCM)"
              />
            </label>
          </div>
        </fieldset>
      ) : null}

      {scmCanEditFreightFinance ? (
        <fieldset className="ovf-entry__fieldset ovf-entry__fieldset--scm-freight-finance">
          <legend className="ovf-entry__legend">Freight &amp; finance (SCM)</legend>
          <p className="muted ovf-entry__intro ovf-entry__intro--tight">
            Same values as the <strong>Freight charges</strong> and <strong>Finance cost</strong> rows in{' '}
            <strong>Vendor purchase</strong> above (editable here because that table is read-only in
            SCM). INR is a fixed amount; <strong>%</strong> uses line sell from{' '}
            <strong>Customer charges</strong>. Same GST % applies in the combined total.
          </p>
          <div className="ovf-entry__blocks ovf-entry__blocks--2 ovf-entry__blocks--no-stack">
            {renderFreightFinanceEditors({ showFreight: true, showFinance: true })}
          </div>
        </fieldset>
      ) : null}

      {salesCanEdit || proofListForDisplay.length > 0 ? (
        <fieldset className="ovf-entry__fieldset ovf-entry__fieldset--proof">
          <legend className="ovf-entry__legend">Supporting documents</legend>
          {!salesCanEdit ? (
            <p className="muted ovf-entry__proof-lead">
              Files Sales attached with this OVF for Finance / SCM reference.
            </p>
          ) : null}
          {salesCanEdit ? (
            <label className="field ovf-entry__proof-upload">
              <span className="field__label">Attach files</span>
              <input
                type="file"
                multiple
                className="field__control"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.doc,.docx,image/*"
                onChange={(e) => {
                  void addProofAttachmentsFromFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <span className="muted ovf-entry__proof-hint">
                Max {Math.round(MAX_OVF_PROOF_BYTES / 100_000) / 10} MB per file · Up to{' '}
                {MAX_OVF_PROOF_FILES} files
              </span>
            </label>
          ) : null}
          {proofListForDisplay.length > 0 ? (
            <ul className="ovf-entry__proof-list">
              {proofListForDisplay.map((a) => (
                <li key={a.id} className="ovf-entry__proof-item">
                  <div className="ovf-entry__proof-item-main">
                    <span className="ovf-entry__proof-name">{a.fileName}</span>
                    <span className="muted ovf-entry__proof-meta">
                      {new Date(a.uploadedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="ovf-entry__proof-item-actions">
                    <a
                      href={a.dataBase64}
                      download={a.fileName}
                      className="link-back ovf-entry__proof-download"
                    >
                      Download
                    </a>
                    {salesCanEdit ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn--compact"
                        onClick={() => removeProofAttachment(a.id)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : salesCanEdit ? (
            <p className="muted ovf-entry__proof-empty">No files attached yet.</p>
          ) : null}
        </fieldset>
      ) : null}

      {mode === 'sales' && salesCanEdit ? (
        <fieldset className="ovf-entry__fieldset ovf-entry__fieldset--share">
          <legend className="ovf-entry__legend">Finance handoff</legend>
          <p className="muted ovf-entry__finance-handoff-hint">
            Send to Finance puts this OVF in the Finance queue first — even if the customer PO was already verified for
            invoicing. After Finance approves, SCM can create the PO.
          </p>
          <div className="ovf-entry__share-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setFinanceModalOpen(true)}
            >
              Send to Finance…
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => handleSaveSalesDraft()}
            >
              Save to draft
            </button>
            {showOvfHtmlDownload ? (
              <button
                type="button"
                className="btn btn-ghost ovf-entry__download-icon-btn"
                title="Download OVF (HTML)"
                aria-label="Download OVF (HTML)"
                onClick={() => handleDownloadHtml()}
              >
                <OvfDownloadIcon />
              </button>
            ) : null}
          </div>
        </fieldset>
      ) : mode !== 'finance' &&
        showOvfHtmlDownload &&
        !embeddedInModal &&
        !scmOvfHtmlDownloadInOverview ? (
        <div className="ovf-entry__actions ovf-entry__actions--compact">
          <button
            type="button"
            className="btn btn-ghost ovf-entry__download-icon-btn"
            title="Download OVF (HTML)"
            aria-label="Download OVF (HTML)"
            onClick={() => handleDownloadHtml()}
          >
            <OvfDownloadIcon />
          </button>
        </div>
      ) : null}

      {mode === 'finance' && wf === 'pending_finance' ? (
        <div className="ovf-entry__finance-decision">
          <h3 className="ovf-entry__finance-decision-title">Finance decision</h3>
          <p className="muted ovf-entry__finance-decision-hint">
            Approving sends this order to SCM so they can create the purchase order.
          </p>
          <div className="ovf-entry__finance-decision-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleFinanceApprove()}
            >
              Approve for SCM
            </button>
            <button
              type="button"
              className={`btn btn-ghost${showRejectPanel ? ' btn--active' : ''}`}
              onClick={() => setShowRejectPanel((v) => !v)}
            >
              Reject…
            </button>
          </div>
          {showRejectPanel ? (
            <div className="ovf-entry__reject-panel">
              <label className="field ovf-entry__reject-field">
                <span className="field__label">Reason (shown to Sales)</span>
                <textarea
                  className="field__control ovf-entry__reject-textarea"
                  rows={3}
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost ovf-entry__reject-confirm"
                onClick={() => handleFinanceReject()}
              >
                Confirm reject
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {shareNotice ? (
        <p className="ovf-entry__share-notice" role="status">
          {shareNotice}
        </p>
      ) : null}

      <FinanceSubmitModal
        open={financeModalOpen}
        title={wf === 'finance_rejected' ? 'Submit again to Finance' : 'Send to Finance'}
        confirmLabel="Submit to Finance"
        onClose={() => setFinanceModalOpen(false)}
        onConfirm={handleSubmitToFinanceQueue}
      />
    </section>
  )
}
