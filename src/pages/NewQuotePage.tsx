import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useSearchParams } from 'react-router-dom'
import { QuoteHtmlPreview } from '../components/QuoteHtmlPreview'
import { useAuth } from '../context/useAuth'
import {
  createEmptyLine,
  createInitialQuoteForm,
  normalizeQuoteFormData,
} from '../lib/quoteFormDefaults'
import {
  QUOTE_FINANCE_HANDOFF_REF_KEY,
  QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY,
  QUOTE_INVOICE_VENDOR_BRIDGE_KEY,
  type QuoteInvoiceSeedPayload,
  type QuoteInvoiceVendorBridgePayload,
} from '../lib/quoteInvoiceSeed'
import {
  allocateNextQuoteRef,
  peekNextQuoteRef,
} from '../lib/quoteRefSequence'
import {
  appendSavedQuote,
  finalizeDraftQuote,
  getSavedQuoteByIdForUser,
  isQuoteDraft,
  saveDraftQuote,
} from '../lib/savedQuotesStorage'
import { syncFinalizedQuoteToServer } from '../lib/quoteServerSync'
import {
  computeQuoteFinanceReviewExtras,
  enrichQuoteFormWithVendorAttachment,
} from '../lib/enrichQuoteVendorRates'
import { maybeOffloadAttachmentToIdb } from '../lib/attachmentIdb'
import { lineItemsSaveValidationMessage } from '../lib/quoteLineItems'
import { getQuoteMoneySummary } from '../lib/quotePdfTemplate'
import type { OvfProofAttachment } from '../types/ovf'
import type { QuoteFinanceReviewState } from '../types/quotePipeline'
import type {
  QuoteFormData,
  QuoteLineForm,
  SenderAddressPreset,
} from '../types/quotePdf'

const MAX_VENDOR_INVOICE_BYTES = 2_600_000

const VENDOR_INVOICE_ACCEPT = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
].join(',')

function readLocalFileAsDataUrl(file: File): Promise<string> {
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

const REQUIRED_SAVE_FIELDS = [
  'customerName',
  'customerAddress',
  'subject',
  'signatoryName',
] as const

type RequiredSaveField = (typeof REQUIRED_SAVE_FIELDS)[number]

type FieldErrorMap = Partial<Record<RequiredSaveField, true>>

/** Quantity: digits only; no meaningless leading zeros (e.g. 05 → 5). */
function sanitizeQtyInput(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits === '') return ''
  const trimmed = digits.replace(/^0+/, '')
  return trimmed === '' ? '0' : trimmed
}

/**
 * Unit price: digits and at most one decimal point.
 * Strips meaningless leading zeros on the whole part (05 → 5, 05.25 → 5.25);
 * keeps a single leading 0 before the dot when needed (0.5, 0.50).
 */
function sanitizeUnitPriceInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const i = cleaned.indexOf('.')
  let intPart: string
  let frac: string | undefined
  if (i === -1) {
    intPart = cleaned
    frac = undefined
  } else {
    intPart = cleaned.slice(0, i)
    frac = cleaned.slice(i + 1).replace(/\./g, '')
  }

  const hasFraction = frac !== undefined
  let intNorm = intPart.replace(/^0+/, '')
  if (intNorm === '') {
    if (intPart === '' && !hasFraction) return ''
    intNorm = '0'
  }
  if (frac === undefined) return intNorm
  return `${intNorm}.${frac}`
}

function serializeQuoteForm(data: QuoteFormData): string {
  return JSON.stringify(data)
}

/** Strict-safe: reads session while `?bootstrap=1` is present; storage cleared in layout effect. */
function readInvoiceBootstrappedForm(): QuoteFormData {
  const base = createInitialQuoteForm()
  if (typeof window === 'undefined') return base
  try {
    const qs = new URLSearchParams(window.location.search)
    if (qs.get('draft')) return base
    if (qs.get('bootstrap') !== '1') return base
    const raw = sessionStorage.getItem(QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY)
    if (!raw) return base
    const payload = JSON.parse(raw) as QuoteInvoiceSeedPayload
    const arr = Array.isArray(payload.lines) ? payload.lines : []
    if (!arr.length) return base
    const lineItems: QuoteLineForm[] = arr.map((L) => {
      const vu = String(L.vendorUnitPrice ?? '').trim()
      return {
        id: crypto.randomUUID(),
        product: String(L.product ?? '').trim(),
        description: String(L.description ?? '').trim(),
        qty: String(L.qty ?? '').trim(),
        unitPrice: '',
        ...(vu ? { vendorUnitPrice: vu } : {}),
        invoiceImported: true,
      }
    })
    return { ...base, lineItems }
  } catch {
    return base
  }
}

export function NewQuotePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const draftIdFromUrl = searchParams.get('draft')
  const { user } = useAuth()
  const [form, setForm] = useState<QuoteFormData>(() => readInvoiceBootstrappedForm())
  const [editingDraftRecordId, setEditingDraftRecordId] = useState<string | null>(
    null,
  )
  const [saveLocked, setSaveLocked] = useState(false)
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false)
  const [pendingQuoteRefPreview, setPendingQuoteRefPreview] = useState<
    string | null
  >(null)
  const [vendorExtractBusy, setVendorExtractBusy] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<{
    type: 'ok' | 'err'
    text: string
  } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({})
  /** Shown under Commercials only after a failed “Save this quote” (line-item rules). */
  const [commercialsSaveNotice, setCommercialsSaveNotice] = useState<
    string | null
  >(null)

  /** Avoid double-processing `?bootstrap=1` (e.g. React Strict Mode): 2nd run had empty storage + false “missing import” error. */
  const invoiceBootstrapHandledRef = useRef(false)
  /** Vendor invoice file for Finance; hydrated from {@link QUOTE_INVOICE_VENDOR_BRIDGE_KEY}. */
  const invoiceVendorBootstrapRef = useRef<OvfProofAttachment | null>(null)
  /** Set when a vendor file is chosen (bridge or file input) so the UI and modal can reflect it. */
  const [vendorInvoiceLabel, setVendorInvoiceLabel] = useState<string | null>(null)

  const formRef = useRef(form)
  formRef.current = form

  const baselineSerialized = useRef<string>('')
  const isDirtyRef = useRef(false)

  const syncBaseline = useCallback((data: QuoteFormData) => {
    baselineSerialized.current = serializeQuoteForm(data)
    isDirtyRef.current = false
  }, [])

  useEffect(() => {
    if (baselineSerialized.current === '') {
      isDirtyRef.current = false
      return
    }
    isDirtyRef.current = serializeQuoteForm(form) !== baselineSerialized.current
  }, [form])

  const money = getQuoteMoneySummary(form)

  const patchForm = useCallback((patch: Partial<QuoteFormData>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    setFieldErrors((prevErr) => {
      const next = { ...prevErr }
      if (
        'customerName' in patch &&
        String(patch.customerName ?? '').trim()
      ) {
        delete next.customerName
      }
      if (
        'customerAddress' in patch &&
        String(patch.customerAddress ?? '').trim()
      ) {
        delete next.customerAddress
      }
      if ('subject' in patch && String(patch.subject ?? '').trim()) {
        delete next.subject
      }
      if (
        'signatoryName' in patch &&
        String(patch.signatoryName ?? '').trim()
      ) {
        delete next.signatoryName
      }
      return next
    })
  }, [])

  const patchLine = useCallback((id: string, patch: Partial<QuoteLineForm>) => {
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((line) => {
        if (line.id !== id) return line
        if (line.invoiceImported) {
          if (!('unitPrice' in patch)) return line
          return { ...line, unitPrice: patch.unitPrice ?? '' }
        }
        return { ...line, ...patch }
      }),
    }))
  }, [])

  const addLine = useCallback(() => {
    setForm((prev) => ({
      ...prev,
      lineItems: [...prev.lineItems, createEmptyLine()],
    }))
  }, [])

  const removeLine = useCallback((id: string) => {
    setForm((prev) => {
      if (prev.lineItems.length <= 1) return prev
      return {
        ...prev,
        lineItems: prev.lineItems.filter((line) => line.id !== id),
      }
    })
  }, [])

  const closeSaveConfirm = useCallback(() => {
    setSaveConfirmOpen(false)
    setPendingQuoteRefPreview(null)
  }, [])

  const validateForSave = useCallback(():
    | { pass: true }
    | {
        pass: false
        fieldErrors?: FieldErrorMap
        message: string
        scrollCommercials?: boolean
      } => {
    if (!user) {
      return { pass: false, message: 'You must be signed in to save.' }
    }
    const errs: FieldErrorMap = {}
    if (!form.customerName.trim()) errs.customerName = true
    if (!form.customerAddress.trim()) errs.customerAddress = true
    if (!form.subject.trim()) errs.subject = true
    if (!form.signatoryName.trim()) errs.signatoryName = true
    if (Object.keys(errs).length > 0) {
      const labels: string[] = []
      if (errs.customerName) labels.push('Recipient name')
      if (errs.customerAddress) labels.push('Address')
      if (errs.subject) labels.push('Subject')
      if (errs.signatoryName) labels.push('Signatory')
      return {
        pass: false,
        fieldErrors: errs,
        message: `Fill in all required fields (marked with *). Missing: ${labels.join(', ')}.`,
      }
    }
    const lineErr = lineItemsSaveValidationMessage(form.lineItems)
    if (lineErr) {
      return {
        pass: false,
        message: lineErr,
        scrollCommercials: true,
      }
    }
    return { pass: true }
  }, [form, user])

  const clearVendorInvoiceAttachment = useCallback(() => {
    invoiceVendorBootstrapRef.current = null
    setVendorInvoiceLabel(null)
    try {
      sessionStorage.removeItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const handleVendorInvoiceFile = useCallback(
    async (file: File | null) => {
      if (!file) return
      setSaveFeedback(null)
      if (file.size > MAX_VENDOR_INVOICE_BYTES) {
        setSaveFeedback({
          type: 'err',
          text: `Vendor invoice is too large (max ~${Math.round(MAX_VENDOR_INVOICE_BYTES / 1e6)} MB).`,
        })
        return
      }
      try {
        const dataUrl = await readLocalFileAsDataUrl(file)
        const comma = dataUrl.indexOf(',')
        const base64 = comma !== -1 ? dataUrl.slice(comma + 1) : ''
        if (!base64.trim()) {
          setSaveFeedback({
            type: 'err',
            text: 'Could not read the vendor invoice file.',
          })
          return
        }
        const mimeRaw = file.type?.trim()
        invoiceVendorBootstrapRef.current = {
          id: crypto.randomUUID(),
          fileName: file.name.trim() || 'vendor-invoice',
          mimeType:
            mimeRaw ||
            (file.name.toLowerCase().endsWith('.pdf')
              ? 'application/pdf'
              : 'application/octet-stream'),
          dataBase64: base64,
          uploadedAt: new Date().toISOString(),
        }
        setVendorInvoiceLabel(file.name.trim() || 'Vendor invoice')
        try {
          sessionStorage.removeItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY)
        } catch {
          /* ignore */
        }
      } catch {
        setSaveFeedback({
          type: 'err',
          text: 'Could not read the vendor invoice file.',
        })
      }
    },
    [],
  )

  const handleSaveQuoteClick = useCallback(() => {
    if (saveLocked) return
    setSaveFeedback(null)
    setFieldErrors({})
    setCommercialsSaveNotice(null)
    const v = validateForSave()
    if (v.pass === false) {
      if (v.fieldErrors) setFieldErrors(v.fieldErrors)
      setSaveFeedback({ type: 'err', text: v.message })
      if (v.scrollCommercials) {
        setCommercialsSaveNotice(v.message)
        window.requestAnimationFrame(() => {
          document
            .getElementById('commercials-section')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
      return
    }
    if (!user) return
    const hasImportedLines = form.lineItems.some((l) => l.invoiceImported)
    const hasVendorAttachment = Boolean(invoiceVendorBootstrapRef.current)
    if (hasImportedLines && !hasVendorAttachment) {
      const msg =
        'Attach the vendor invoice file (Commercials) so Finance can review and approve this quote.'
      setSaveFeedback({ type: 'err', text: msg })
      setCommercialsSaveNotice(msg)
      window.requestAnimationFrame(() => {
        document
          .getElementById('commercials-section')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      return
    }
    setPendingQuoteRefPreview(peekNextQuoteRef(user.oid))
    setSaveConfirmOpen(true)
  }, [saveLocked, validateForSave, user, form.lineItems])

  const handleConfirmSaveQuote = useCallback(() => {
    if (saveLocked || vendorExtractBusy) return
    setSaveFeedback(null)
    setFieldErrors({})
    setCommercialsSaveNotice(null)
    const v = validateForSave()
    if (v.pass === false) {
      closeSaveConfirm()
      if (v.fieldErrors) setFieldErrors(v.fieldErrors)
      setSaveFeedback({ type: 'err', text: v.message })
      if (v.scrollCommercials) {
        setCommercialsSaveNotice(v.message)
        window.requestAnimationFrame(() => {
          document
            .getElementById('commercials-section')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
      return
    }
    if (!user) return
    const hasImportedLines = form.lineItems.some((l) => l.invoiceImported)
    const hasVendorAttachment = Boolean(invoiceVendorBootstrapRef.current)
    const shouldSendToFinance = hasImportedLines || hasVendorAttachment

    setVendorExtractBusy(true)
    void (async () => {
      try {
        const quoteRef = allocateNextQuoteRef(user.oid)
        let snapshot: QuoteFormData = { ...form, quoteRef }
        const attachment = invoiceVendorBootstrapRef.current
        let financeExtras: Partial<QuoteFinanceReviewState> = {}
        const missingInvoiceAttachmentNotice =
          shouldSendToFinance && hasImportedLines && !attachment
            ? 'Quote was sent to Finance, but the vendor invoice file could not be attached. If Finance requests it, upload the invoice again from Commercials.'
            : null
        if (shouldSendToFinance && attachment) {
          try {
            snapshot = await enrichQuoteFormWithVendorAttachment(
              snapshot,
              attachment,
            )
            financeExtras = await computeQuoteFinanceReviewExtras(
              snapshot,
              attachment,
            )
          } catch {
            /* extraction failure — still save quote without vendor rates */
          }
        }

        let quoteFinanceReview: QuoteFinanceReviewState | undefined
        if (shouldSendToFinance) {
          const persistedInvoice = attachment
            ? await maybeOffloadAttachmentToIdb(attachment)
            : undefined
          quoteFinanceReview = {
            workflowStatus: 'pending_finance',
            vendorInvoice: persistedInvoice ?? undefined,
            submittedToFinanceAt: new Date().toISOString(),
            ...financeExtras,
          }
        }

        setForm(snapshot)
        if (editingDraftRecordId) {
          const finalized = finalizeDraftQuote(
            editingDraftRecordId,
            user.oid,
            quoteRef,
            snapshot,
            {
              savedByDisplayName: user.displayName,
              ...(quoteFinanceReview ? { quoteFinanceReview } : {}),
            },
          )
          if (!finalized) {
            setSaveFeedback({
              type: 'err',
              text: 'Could not update that draft (it may have been removed). Try again from Sales or start a new quote.',
            })
            closeSaveConfirm()
            return
          }
          void syncFinalizedQuoteToServer(finalized, user)
        } else {
          const created = appendSavedQuote({
            savedBy: user.oid,
            savedByDisplayName: user.displayName,
            quoteRef,
            formSnapshot: snapshot,
            ...(quoteFinanceReview ? { quoteFinanceReview } : {}),
          })
          void syncFinalizedQuoteToServer(created, user)
        }
        try {
          sessionStorage.removeItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY)
        } catch {
          /* ignore */
        }
        if (quoteFinanceReview) {
          try {
            sessionStorage.setItem(
              QUOTE_FINANCE_HANDOFF_REF_KEY,
              snapshot.quoteRef,
            )
          } catch {
            /* ignore */
          }
        }
        invoiceVendorBootstrapRef.current = null
        setVendorInvoiceLabel(null)
        setFieldErrors({})
        closeSaveConfirm()
        if (missingInvoiceAttachmentNotice) {
          setSaveFeedback({ type: 'ok', text: missingInvoiceAttachmentNotice })
        }
        setSaveLocked(true)
        syncBaseline(snapshot)
        navigate('/sales', {
          replace: true,
          ...(quoteFinanceReview
            ? { state: { quoteSubmittedForFinanceReview: snapshot.quoteRef } }
            : undefined),
        })
      } finally {
        setVendorExtractBusy(false)
      }
    })()
  }, [
    form,
    user,
    saveLocked,
    vendorExtractBusy,
    navigate,
    validateForSave,
    closeSaveConfirm,
    editingDraftRecordId,
    syncBaseline,
  ])

  useEffect(() => {
    if (!saveConfirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSaveConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveConfirmOpen, closeSaveConfirm])

  useEffect(() => {
    const first = REQUIRED_SAVE_FIELDS.find((k) => fieldErrors[k])
    if (!first) return
    window.requestAnimationFrame(() => {
      document
        .getElementById(`field-${first}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [fieldErrors])

  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) => {
        if (saveLocked) return false
        if (currentLocation.pathname === nextLocation.pathname) return false
        return isDirtyRef.current
      },
      [saveLocked],
    ),
  )

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') blocker.reset?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [blocker.state, blocker])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useLayoutEffect(() => {
    const boot = searchParams.get('bootstrap') === '1'
    if (!boot) {
      invoiceBootstrapHandledRef.current = false
      return
    }
    if (draftIdFromUrl) {
      try {
        sessionStorage.removeItem(QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      void navigate(`/sales/quote/new?draft=${encodeURIComponent(draftIdFromUrl)}`, {
        replace: true,
      })
      return
    }
    if (invoiceBootstrapHandledRef.current) {
      void navigate('/sales/quote/new', { replace: true })
      return
    }
    invoiceBootstrapHandledRef.current = true

    let raw: string | null = null
    try {
      raw = sessionStorage.getItem(QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY)
    } catch {
      raw = null
    }
    if (raw) {
      try {
        sessionStorage.removeItem(QUOTE_INVOICE_BOOTSTRAP_STORAGE_KEY)
      } catch {
        /* ignore */
      }
    } else {
      setSaveFeedback(null)
    }
    void navigate('/sales/quote/new', { replace: true })
  }, [searchParams, navigate, draftIdFromUrl])

  /**
   * Hydrate vendor invoice for Finance from session (written when Sales continues from
   * “Quote from invoice”). Must run even while `?bootstrap=1` is still on the URL so the
   * first paint shows the carried-over file — browsers cannot pre-fill `<input type=file>`.
   */
  useLayoutEffect(() => {
    try {
      const raw = sessionStorage.getItem(QUOTE_INVOICE_VENDOR_BRIDGE_KEY)
      if (!raw || invoiceVendorBootstrapRef.current) return
      const p = JSON.parse(raw) as QuoteInvoiceVendorBridgePayload
      const b64 = String(p.dataBase64 ?? '').trim()
      if (!b64) return
      invoiceVendorBootstrapRef.current = {
        id: crypto.randomUUID(),
        fileName:
          String(p.fileName ?? 'vendor-invoice').trim() || 'vendor-invoice',
        mimeType:
          String(p.mimeType || 'application/octet-stream').trim() ||
          'application/octet-stream',
        dataBase64: b64,
        uploadedAt: new Date().toISOString(),
      }
      setVendorInvoiceLabel(
        String(p.fileName ?? '').trim() || 'Vendor invoice attached',
      )
    } catch {
      /* ignore */
    }
  }, [searchParams])

  useLayoutEffect(() => {
    if (!user || draftIdFromUrl) return
    syncBaseline(formRef.current)
  }, [user, draftIdFromUrl, syncBaseline])

  useEffect(() => {
    if (!user) return
    if (!draftIdFromUrl) {
      setEditingDraftRecordId(null)
      return
    }
    const rec = getSavedQuoteByIdForUser(draftIdFromUrl, user.oid)
    if (!rec || !isQuoteDraft(rec)) {
      setSaveFeedback({
        type: 'err',
        text: 'Draft not found, or this quote is already finalized.',
      })
      setEditingDraftRecordId(null)
      return
    }
    const loaded = normalizeQuoteFormData({
      ...rec.formSnapshot,
      quoteRef: '',
    } as QuoteFormData & { customerTitle?: string })
    const creatorName = user.displayName.trim()
    const nextForm =
      !loaded.signatoryName.trim() && creatorName
        ? { ...loaded, signatoryName: creatorName }
        : loaded
    setForm(nextForm)
    setEditingDraftRecordId(rec.id)
    setSaveFeedback(null)
    setFieldErrors({})
    syncBaseline(nextForm)
  }, [draftIdFromUrl, user, navigate, syncBaseline])

  /** Default signatory to the signed-in user (same label as the sidebar) when still blank. */
  useEffect(() => {
    if (!user || draftIdFromUrl) return
    const name = user.displayName.trim()
    if (!name) return
    setForm((prev) => {
      if (prev.signatoryName.trim()) return prev
      return { ...prev, signatoryName: name }
    })
  }, [user, draftIdFromUrl])

  const handleLeaveSaveDraft = useCallback(() => {
    if (!user) {
      blocker.reset?.()
      return
    }
    setSaveFeedback(null)
    const draftSnapshot: QuoteFormData = { ...form, quoteRef: '' }
    saveDraftQuote({
      savedBy: user.oid,
      formSnapshot: draftSnapshot,
      existingDraftId: editingDraftRecordId,
    })
    syncBaseline(form)
    blocker.proceed?.()
  }, [user, form, editingDraftRecordId, syncBaseline, blocker])

  const handleLeaveDiscard = useCallback(() => {
    blocker.proceed?.()
  }, [blocker])

  const handleSaveDraft = useCallback(() => {
    if (saveLocked || saveConfirmOpen) return
    if (!user) {
      setSaveFeedback({ type: 'err', text: 'You must be signed in to save.' })
      return
    }
    setSaveFeedback(null)
    const draftSnapshot: QuoteFormData = { ...form, quoteRef: '' }
    saveDraftQuote({
      savedBy: user.oid,
      formSnapshot: draftSnapshot,
      existingDraftId: editingDraftRecordId,
    })
    syncBaseline(form)
    navigate('/sales', { replace: true })
  }, [
    form,
    user,
    saveLocked,
    saveConfirmOpen,
    editingDraftRecordId,
    navigate,
    syncBaseline,
  ])

  return (
    <div className="new-quote-page">
      <p className="panel__back">
        <Link to="/sales" className="link-back">
          ← Back to Sales
        </Link>
      </p>
      <h2 className="new-quote-page__title">New quote</h2>

      <div className="new-quote-layout">
        <div className="new-quote-form card-surface">
          <h3 className="new-quote-form__heading">Quote details</h3>
          {saveFeedback?.type === 'err' ? (
            <div className="form-validation-banner" role="alert">
              {saveFeedback.text}
            </div>
          ) : null}

          {editingDraftRecordId ? (
            <div className="new-quote-draft-banner form-grid__full" role="status">
              <p>
                Editing a <strong>draft</strong>.
              </p>
            </div>
          ) : null}

          <div className="field form-grid__full sender-preset">
            <span className="field__label">
              Sender address (top-right + both footers)
            </span>
            <div className="sender-preset__options" role="radiogroup">
              {(
                [
                  ['primary', 'Cache Digitech (letterhead)'],
                  ['secondary', 'Secondary (xyz placeholder)'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="sender-preset__radio">
                  <input
                    type="radio"
                    name="senderAddressPreset"
                    checked={form.senderAddressPreset === value}
                    onChange={() =>
                      patchForm({
                        senderAddressPreset: value as SenderAddressPreset,
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span className="field__label">Quote date</span>
              <input
                type="date"
                className="field__control"
                value={form.quoteDate}
                onChange={(e) => patchForm({ quoteDate: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Valid until</span>
              <input
                type="date"
                className="field__control"
                value={form.validUntil}
                onChange={(e) => patchForm({ validUntil: e.target.value })}
              />
            </label>
            <label
              className={`field form-grid__full${fieldErrors.customerName ? ' field--invalid' : ''}`}
              htmlFor="field-customerName"
            >
              <span className="field__label" id="label-recipient-name">
                Recipient name{' '}
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </span>
              <input
                id="field-customerName"
                className="field__control"
                value={form.customerName}
                onChange={(e) => patchForm({ customerName: e.target.value })}
                placeholder="e.g. Mr. Rishi Singh"
                aria-required="true"
                aria-labelledby="label-recipient-name"
                aria-invalid={fieldErrors.customerName ? true : undefined}
              />
            </label>
            <label className="field form-grid__full" htmlFor="field-customerCompanyName">
              <span className="field__label">Company name</span>
              <input
                id="field-customerCompanyName"
                type="text"
                className="field__control"
                value={form.customerCompanyName}
                onChange={(e) =>
                  patchForm({ customerCompanyName: e.target.value })
                }
                
                title="Use the spelling from the buyer’s PO when it shows a company. If there is no company on the PO, an informal trading or short name here is fine."
                autoComplete="organization"
              />
            </label>
            <label
              className={`field form-grid__full${fieldErrors.customerAddress ? ' field--invalid' : ''}`}
              htmlFor="field-customerAddress"
            >
              <span className="field__label">
                Address{' '}
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </span>
              <textarea
                id="field-customerAddress"
                className="field__control field__control--textarea"
                rows={5}
                value={form.customerAddress}
                onChange={(e) =>
                  patchForm({ customerAddress: e.target.value })
                }
                aria-required="true"
                aria-invalid={fieldErrors.customerAddress ? true : undefined}
                placeholder={
                  'One line per row in the PDF (after recipient and company name).\n' +
                  '8th Floor, IndiQube Vatika, Tower-B,\n' +
                  'Vatika Tower, Golf Course Road, Suncity, Sector 54,\n' +
                  'Gurugram, Haryana – 122003'
                }
              />
            </label>
            <label
              className={`field form-grid__full${fieldErrors.subject ? ' field--invalid' : ''}`}
              htmlFor="field-subject"
            >
              <span className="field__label">
                Subject (PDF: Sub: …){' '}
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </span>
              <input
                id="field-subject"
                type="text"
                className="field__control"
                value={form.subject}
                onChange={(e) => patchForm({ subject: e.target.value })}
                placeholder="e.g. Commercials for Adobe Creative Cloud & Acrobat PDF Editor Licenses"
                aria-required="true"
                aria-invalid={fieldErrors.subject ? true : undefined}
              />
            </label>
            <label className="field form-grid__full">
              <span className="field__label">Salutation</span>
              <input
                type="text"
                className="field__control"
                value={form.quoteSalutation}
                onChange={(e) =>
                  patchForm({ quoteSalutation: e.target.value })
                }
                placeholder="Dear Sir,"
              />
            </label>
            <label className="field form-grid__full">
              <span className="field__label">Intro (before table)</span>
              <textarea
                className="field__control field__control--textarea"
                rows={5}
                value={form.quoteIntro}
                onChange={(e) => patchForm({ quoteIntro: e.target.value })}
                placeholder="Paragraphs before the commercials table; leave a blank line between paragraphs."
              />
            </label>

            <h3
              id="commercials-section"
              className="new-quote-form__heading new-quote-form__heading--lines form-grid__full"
            >
              Commercials
            </h3>
            {commercialsSaveNotice ? (
              <div
                className="new-quote-commercials-warning form-grid__full"
                role="alert"
              >
                {commercialsSaveNotice}
              </div>
            ) : null}
            <div className="line-items form-grid__full">
            <div
              className="line-item-row line-items__header"
              role="row"
              aria-label="Column headings"
            >
              <span className="line-item-row__idx line-items__header-label">
                #
              </span>
              <span className="line-items__header-label">Product</span>
              <span className="line-items__header-label">Description</span>
              <span className="line-items__header-label">Qty</span>
              <span className="line-items__header-label">Unit (INR)</span>
              <span className="line-items__header-spacer" aria-hidden="true" />
            </div>
            {form.lineItems.map((line, index) => (
              <div key={line.id} className="line-item-row">
                <span className="line-item-row__idx muted">{index + 1}</span>
                <input
                  className={`field__control line-item-row__product${line.invoiceImported ? ' field__control--from-invoice' : ''}`}
                  placeholder="Product"
                  readOnly={line.invoiceImported}
                  aria-readonly={line.invoiceImported ? true : undefined}
                  title={
                    line.invoiceImported
                      ? 'From invoice — not editable'
                      : undefined
                  }
                  value={line.product}
                  onChange={(e) =>
                    patchLine(line.id, { product: e.target.value })
                  }
                />
                <input
                  className={`field__control line-item-row__desc${line.invoiceImported ? ' field__control--from-invoice' : ''}`}
                  placeholder="Description"
                  readOnly={line.invoiceImported}
                  aria-readonly={line.invoiceImported ? true : undefined}
                  title={
                    line.invoiceImported
                      ? 'From invoice — not editable'
                      : undefined
                  }
                  value={line.description}
                  onChange={(e) =>
                    patchLine(line.id, { description: e.target.value })
                  }
                />
                <input
                  className={`field__control line-item-row__num${line.invoiceImported ? ' field__control--from-invoice' : ''}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="Qty"
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={line.invoiceImported}
                  aria-readonly={line.invoiceImported ? true : undefined}
                  title={
                    line.invoiceImported
                      ? 'From invoice — not editable'
                      : undefined
                  }
                  value={line.qty}
                  onChange={(e) =>
                    patchLine(line.id, { qty: sanitizeQtyInput(e.target.value) })
                  }
                />
                <input
                  className="field__control line-item-row__num"
                  type="text"
                  inputMode="decimal"
                  placeholder="Unit price"
                  autoComplete="off"
                  spellCheck={false}
                  title="Customer quote unit price (INR), not the supplier’s invoice rate"
                  value={line.unitPrice}
                  onChange={(e) =>
                    patchLine(line.id, {
                      unitPrice: sanitizeUnitPriceInput(e.target.value),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-ghost line-item-row__remove"
                  disabled={form.lineItems.length <= 1}
                  onClick={() => removeLine(line.id)}
                  aria-label={`Remove line ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
            <div className="form-grid__full">
              <button
                type="button"
                className="btn btn-ghost line-items__add"
                onClick={addLine}
              >
                Add line
              </button>
            </div>

            <div className="money-summary form-grid__full">
              <div className="money-summary__row money-summary__row--total">
                <span>Total</span>
                <span>{money.total.toFixed(2)}</span>
              </div>
            </div>

            <label className="field form-grid__full">
              <span className="field__label">Closing (after table)</span>
              <textarea
                className="field__control field__control--textarea"
                rows={3}
                value={form.quoteClosing}
                onChange={(e) => patchForm({ quoteClosing: e.target.value })}
                placeholder="Paragraph printed after the commercials table and totals."
              />
            </label>
            <label className="field form-grid__full">
              <span className="field__label">
                Terms and conditions (final PDF page)
              </span>
              <textarea
                className="field__control field__control--textarea"
                rows={10}
                value={form.termsAndConditions}
                onChange={(e) =>
                  patchForm({ termsAndConditions: e.target.value })
                }
                placeholder="Numbered list, one line per row as in the PDF."
              />
            </label>
            <label
              className={`field form-grid__full${fieldErrors.signatoryName ? ' field--invalid' : ''}`}
              htmlFor="field-signatoryName"
            >
              <span className="field__label">
                Signatory (after “Thank you,”){' '}
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </span>
              <input
                id="field-signatoryName"
                className="field__control"
                name="quote-signatory"
                autoComplete="off"
                value={form.signatoryName}
                onChange={(e) => patchForm({ signatoryName: e.target.value })}
                placeholder="Full name as printed on the quote"
                aria-required="true"
                aria-invalid={fieldErrors.signatoryName ? true : undefined}
              />
            </label>

            <div className="new-quote-form__footer form-grid__full">
              <div
                id="vendor-invoice-finance-field"
                className="field new-quote-form__footer-vendor"
              >
                <span className="field__label">Vendor invoice (for Finance)</span>
                {vendorInvoiceLabel ? (
                  <div
                    className="new-quote-vendor-invoice-status card-surface"
                    role="status"
                  >
                    <p className="new-quote-vendor-invoice-status__text">
                      <strong>Supplier invoice for Finance:</strong>{' '}
                      <span title={vendorInvoiceLabel}>{vendorInvoiceLabel}</span>
                    </p>
                    <div className="new-quote-vendor-invoice-row new-quote-vendor-invoice-row--tight">
                      <label className="btn btn-ghost btn--compact">
                        Replace file
                        <input
                          type="file"
                          className="new-quote-sr-only"
                          accept={VENDOR_INVOICE_ACCEPT}
                          onChange={(e) =>
                            void handleVendorInvoiceFile(e.target.files?.[0] ?? null)
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-ghost btn--compact"
                        onClick={clearVendorInvoiceAttachment}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="new-quote-vendor-invoice-row">
                    <input
                      type="file"
                      className="field__control"
                      accept={VENDOR_INVOICE_ACCEPT}
                      onChange={(e) =>
                        void handleVendorInvoiceFile(e.target.files?.[0] ?? null)
                      }
                    />
                  </div>
                )}
              </div>

              <div className="new-quote-form__save">
                <div className="new-quote-form__save-actions new-quote-form__save-actions--split">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={handleSaveDraft}
                    disabled={saveLocked || saveConfirmOpen || !user}
                  >
                    Save as draft
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleSaveQuoteClick}
                    disabled={saveLocked || saveConfirmOpen || !user}
                  >
                    Save this quote
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="new-quote-preview card-surface">
          <div className="new-quote-preview__head">
            <h3 className="new-quote-preview__title">Quote preview</h3>
            <span className="preview-pill preview-pill--live">Live</span>
          </div>
          <div className="pdf-preview pdf-preview--html">
            <QuoteHtmlPreview data={form} />
          </div>
        </aside>
      </div>

      {saveConfirmOpen && pendingQuoteRefPreview ? (
        <div
          className="save-quote-modal-overlay"
          role="presentation"
          onClick={closeSaveConfirm}
        >
          <div
            className="save-quote-modal card-surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-quote-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="save-quote-modal-title" className="save-quote-modal__title">
              Confirm quote number
            </h4>
            <p className="save-quote-modal__lead">
              Next number:{' '}
              <strong className="save-quote-modal__ref">
                {pendingQuoteRefPreview}
              </strong>
            </p>
            {form.lineItems.some((l) => l.invoiceImported) ||
            vendorInvoiceLabel ? (
              <p className="save-quote-modal__lead muted">
                After you confirm, this number is final and the quote (with the attached
                vendor invoice, if any) is sent to the Finance queue for approval. Open the
                Finance workspace to review it, or work from the shared quotes list in this
                browser.
              </p>
            ) : null}
            <div className="save-quote-modal__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeSaveConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmSaveQuote}
                disabled={saveLocked || vendorExtractBusy}
              >
                {vendorExtractBusy ? 'Reading invoice…' : 'Confirm and save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {blocker.state === 'blocked' ? (
        <div
          className="save-quote-modal-overlay"
          role="presentation"
          onClick={() => blocker.reset?.()}
        >
          <div
            className="save-quote-modal card-surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-quote-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="leave-quote-modal-title" className="save-quote-modal__title">
              Save your work?
            </h4>
            <p className="save-quote-modal__lead">Unsaved changes.</p>
            <div className="save-quote-modal__actions save-quote-modal__actions--leave">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleLeaveSaveDraft}
                disabled={!user}
              >
                Save as draft
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleLeaveDiscard}
              >
                Leave without saving
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => blocker.reset?.()}
              >
                Stay on this page
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
