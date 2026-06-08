import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import {
  COMPANY_ADDRESS_PRESET_CUSTOM,
  COMPANY_DELIVERY_LOCATIONS,
  getCompanyLocationById,
} from '../lib/companyLocations'
import {
  addPoCompanyAddressPreset,
  getAddressTextForCompanyPresetId,
  labelForAddressPresetId,
  listPoCompanyAddressPresets,
  type PoCompanyAddressPreset,
  resolveAddressPresetId,
} from '../lib/poCompanyAddressPresetsStorage'
import { getScmPoDefaultBillingAddressForPdf } from '../lib/scmPoLetterhead'
import { filterCommercialLines } from '../lib/quoteLineItems'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import {
  allocateNextCompanyPoNumber,
  parseCompanyPoParts,
} from '../lib/companyPoNumber'
import { FINANCE_PO_FINALIZED_NOTICE_KEY } from '../lib/quoteInvoiceSeed'
import { allocateNextPoRef } from '../lib/scmPoRefSequence'
import {
  getSavedQuoteById,
  updateSavedQuoteScmPo,
  type SavedQuoteRecord,
} from '../lib/savedQuotesStorage'
import {
  createVendorForUser,
  getVendorForUser,
  listVendorsForUser,
  updateVendorForUser,
} from '../lib/vendorsStorage'
import { mergeScmPoGapsFromOvfAndQuote } from '../lib/scmPoOvfCoalesce'
import { effectiveOvfWorkflow } from '../lib/ovfWorkflow'
import {
  parseVendorPartyFromInvoiceText,
  pickVendorInvoiceAttachment,
} from '../lib/extractOvfPartyDetails'
import { extractInvoiceRawTextForFooterScan } from '../lib/extractInvoiceLineItems'
import { proofAttachmentBlob } from '../lib/quoteExport'
import {
  joinItemsToTerms,
  parseTermsStringToItems,
  readScmPoGlobalTerms,
  type ScmPoGlobalTermsItem,
} from '../lib/scmPoTermsStorage'
import {
  SCM_PO_TAX_PERCENT_OPTIONS,
  SCM_PO_TYPE_OPTIONS,
  computeLineSubtotalInr,
  computeLineTaxAmountInr,
  computeLineTotalInr,
  defaultPoType,
  formatInrScm,
  mergeQuoteProductAndDescriptionForItemDetails,
  normalizeScmPoLine,
  normalizeScmPoLineTaxPct,
} from '../lib/scmPoLine'
import type { ScmPoLine, ScmPoPaymentPreset, ScmPoStoredState } from '../types/scmPo'
import type { QuoteFormData } from '../types/quotePdf'
import type { VendorAddress, VendorEntry } from '../types/vendor'
import { ScmPoDocumentPreview } from '../components/ScmPoDocumentPreview'
import { downloadScmPoPdfFromRenderedPreview } from '../lib/scmPoPdf'

function formatVendorAddressForSelectOption(a: VendorAddress): string {
  const rawLines = String(a.lines ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
  const oneLine = rawLines.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  return oneLine || '—'
}

function nextCompanyPoNumberForLocation(
  current: string,
  locationId: string,
): string {
  const loc = getCompanyLocationById(locationId)
  const want = (loc?.poPrefix ?? '') as '' | 'CT' | 'CDT'
  const trimmed = String(current ?? '').trim()
  if (!trimmed) return allocateNextCompanyPoNumber(want)

  const p = parseCompanyPoParts(trimmed)
  if (!p) {
    // Unknown format — don't guess; keep as-is.
    return trimmed
  }
  if ((p.prefix || '') === (want || '')) return trimmed

  // Other series (CT vs CDT, etc.): 001, 002, … are per-prefix; do not copy the other branch’s seq.
  return allocateNextCompanyPoNumber(want)
}

type ScmPoAddressPresetFieldProps = {
  label: string
  ariaLabel: string
  idBase: 'billing' | 'shipping'
  value: string
  onChange: (value: string) => void
  rows: number
  editing: boolean
  onToggleEdit: () => void
  customPresets: readonly PoCompanyAddressPreset[]
  onRegisterNewPreset: (label: string, address: string) => string | null
}

/** One line when the address is collapsed (not in edit). Full text is only in the editor. */
function oneLineAddressSummaryForLock(
  value: string,
  preset: string,
  customPresets: readonly PoCompanyAddressPreset[],
): string {
  if (preset && preset !== COMPANY_ADDRESS_PRESET_CUSTOM) {
    const L = labelForAddressPresetId(preset, customPresets)
    if (L) return L
  }
  const t = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
  if (!t) return '—'
  const one = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ')
  if (one.length > 100) return `${one.slice(0, 99)}…`
  return one
}

function ScmPoAddressPresetField({
  label,
  ariaLabel,
  idBase,
  value,
  onChange,
  rows,
  editing,
  onToggleEdit,
  customPresets,
  onRegisterNewPreset,
}: ScmPoAddressPresetFieldProps) {
  const selectId = `scm-po-addr-preset-${idBase}`
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addAddress, setAddAddress] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)

  const preset = resolveAddressPresetId(value, customPresets)
  const lockLine = oneLineAddressSummaryForLock(value, preset, customPresets)

  useEffect(() => {
    if (editing) {
      const t = window.setTimeout(() => taRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
  }, [editing])

  return (
    <div className="scm-po__field scm-po__field--wide scm-po__address-preset">
      <span className="scm-po__label">{label}</span>
      <div className="scm-po__addr-row">
        <select
          id={selectId}
          className="field__control"
          value={preset}
          disabled={editing}
          onChange={(e) => {
            const id = e.target.value
            if (id === COMPANY_ADDRESS_PRESET_CUSTOM) return
            const text = getAddressTextForCompanyPresetId(id, customPresets)
            if (text) onChange(text)
          }}
          aria-label="Switch company address preset"
        >
          {COMPANY_DELIVERY_LOCATIONS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
          {customPresets.length > 0
            ? customPresets.map((c) => (
                <option key={c.id} value={c.id} title={c.label}>
                  {c.label}
                </option>
              ))
            : null}
          <option value={COMPANY_ADDRESS_PRESET_CUSTOM}>Custom (manual)…</option>
        </select>
        <button
          type="button"
          className="btn btn-ghost btn--compact scm-po__addr-add-trigger"
          disabled={editing}
          title="Save a new company address to the list for everyone (this browser)"
          aria-label="Add new saved company address"
          onClick={() => {
            setAddErr(null)
            setAddOpen((o) => {
              if (o) {
                setAddLabel('')
                setAddAddress('')
              }
              return !o
            })
          }}
        >
          <svg
            className="scm-po__addr-add-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn--compact scm-po__addr-edit-btn"
          onClick={onToggleEdit}
          aria-pressed={editing}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {addOpen ? (
        <div
          className="scm-po__addr-add-panel"
          id={`scm-po-addr-add-${idBase}`}
          role="region"
        >
          <p className="muted scm-po__addr-add-hint">
            Save for reuse on this device: the name appears in the list for billing and
            shipping on other POs.
          </p>
          {addErr ? (
            <p className="scm-po__form-error" role="alert">
              {addErr}
            </p>
          ) : null}
          <label className="scm-po__field">
            <span className="scm-po__label">Display name</span>
            <input
              type="text"
              className="field__control"
              value={addLabel}
              onChange={(e) => {
                setAddLabel(e.target.value)
                setAddErr(null)
              }}
              placeholder="e.g. Noida office"
              maxLength={120}
            />
          </label>
          <label className="scm-po__field scm-po__field--wide">
            <span className="scm-po__label">Full address</span>
            <textarea
              className="field__control scm-po__textarea"
              rows={4}
              value={addAddress}
              onChange={(e) => {
                setAddAddress(e.target.value)
                setAddErr(null)
              }}
              placeholder="Multi-line is fine"
            />
          </label>
          <div className="scm-po__addr-add-actions">
            <button
              type="button"
              className="btn btn-ghost btn--compact"
              onClick={() => {
                setAddOpen(false)
                setAddErr(null)
                setAddLabel('')
                setAddAddress('')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn--compact"
              onClick={() => {
                setAddErr(null)
                const err = onRegisterNewPreset(
                  addLabel,
                  addAddress,
                )
                if (err) {
                  setAddErr(err)
                  return
                }
                setAddOpen(false)
                setAddLabel('')
                setAddAddress('')
              }}
            >
              Save &amp; use
            </button>
          </div>
        </div>
      ) : null}
      {editing ? (
        <textarea
          ref={taRef}
          className="field__control scm-po__textarea"
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
        />
      ) : preset === COMPANY_ADDRESS_PRESET_CUSTOM ? (
        <div className="scm-po__addr-lock-wrap">
          <span className="scm-po__sr-only">
            {value.trim() || 'Empty address.'} Use Edit to see or change the full text.
          </span>
          <div
            className="scm-po__addr-lock-preview"
            title={value.trim() || undefined}
            aria-hidden="true"
          >
            {lockLine}
          </div>
        </div>
      ) : value.trim() ? (
        <div className="scm-po__addr-lock-wrap">
          <span className="scm-po__sr-only">
            {value.trim()}. To change, pick a different company above, or use Edit to modify
            the full text.
          </span>
        </div>
      ) : null}
    </div>
  )
}

const PO_LINE_DETAILS_MIN_PX = 52

/** Item details: grows with content (no inner scroll for normal typing). */
function ScmPoLineDetailsTextarea({
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  'aria-label'?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = () => {
      el.style.width = '100%'
      el.style.maxWidth = '100%'
      el.style.height = 'auto'
      el.style.height = `${Math.max(el.scrollHeight, PO_LINE_DETAILS_MIN_PX)}px`
    }
    sync()
    const parent = el.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => {
      sync()
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [value])

  return (
    <textarea
      ref={ref}
      className="field__control scm-po__textarea scm-po__textarea--lines"
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    />
  )
}

function newPoTermLineItem(): ScmPoGlobalTermsItem {
  return {
    id: `po-term-${crypto.randomUUID()}`,
    text: '',
    pinned: true,
  }
}

function initialPoTermItems(
  lineItems: ScmPoGlobalTermsItem[] | undefined,
  termsText: string,
): ScmPoGlobalTermsItem[] {
  if (lineItems && lineItems.length > 0) return lineItems
  const parsed = parseTermsStringToItems(termsText)
  return parsed.length > 0 ? parsed : [newPoTermLineItem()]
}

/** Per-PO terms: one box per point, drag, Fix checkbox, + to add. */
function ScmPoTermsLinesEditor({
  value,
  lineItems: lineItemsProp,
  onChange,
}: {
  value: string
  lineItems: ScmPoGlobalTermsItem[] | undefined
  onChange: (next: {
    termsAndConditions: string
    termsLineItems: ScmPoGlobalTermsItem[]
  }) => void
}) {
  const [items, setItems] = useState<ScmPoGlobalTermsItem[]>(() =>
    initialPoTermItems(lineItemsProp, value),
  )
  /** Synchronous id for HTML5 drop — React state from onDragStart may not flush before onDrop. */
  const dragTermIdRef = useRef<string | null>(null)
  const dragGhostElRef = useRef<HTMLDivElement | null>(null)

  const removeDragGhost = () => {
    const g = dragGhostElRef.current
    if (g?.parentNode) g.parentNode.removeChild(g)
    dragGhostElRef.current = null
  }

  const commit = (next: ScmPoGlobalTermsItem[]) => {
    setItems(next)
    onChange({
      termsAndConditions: joinItemsToTerms(next, { onlyPinned: true }),
      termsLineItems: next,
    })
  }

  return (
    <div className="scm-po__terms-po-list">
      {items.map((it, idx) => (
        <div
          key={it.id}
          className={
            it.pinned
              ? 'scm-po__terms-item scm-po__terms-item--po'
              : 'scm-po__terms-item scm-po__terms-item--po scm-po__terms-item--unfixed'
          }
          onDragOver={(e) => {
            e.preventDefault()
          }}
          onDrop={(e) => {
            e.preventDefault()
            const fromId =
              dragTermIdRef.current ||
              e.dataTransfer.getData('text/plain') ||
              null
            if (!fromId || fromId === it.id) return
            const fromIdx = items.findIndex((x) => x.id === fromId)
            const toIdx = items.findIndex((x) => x.id === it.id)
            if (fromIdx < 0 || toIdx < 0) return
            const next = [...items]
            const [moved] = next.splice(fromIdx, 1)
            next.splice(toIdx, 0, moved!)
            commit(next)
            dragTermIdRef.current = null
          }}
        >
          <div className="scm-po__terms-item-head">
            <span
              role="button"
              tabIndex={0}
              className="btn btn-ghost btn--compact scm-po__terms-drag"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                try {
                  e.dataTransfer.setData('text/plain', it.id)
                } catch {
                  /* IE legacy throws on some types; id still in ref */
                }
                dragTermIdRef.current = it.id

                const handle = e.currentTarget as HTMLElement
                const card = handle.closest('.scm-po__terms-item')
                removeDragGhost()

                const ghost = document.createElement('div')
                ghost.className = 'scm-po__terms-drag-ghost'
                const w = card?.getBoundingClientRect().width
                if (w) ghost.style.width = `${Math.min(w, 720)}px`

                const titleEl = document.createElement('div')
                titleEl.className = 'scm-po__terms-drag-ghost__title'
                titleEl.textContent = `Point ${idx + 1}`

                const snippet = document.createElement('div')
                snippet.className = 'scm-po__terms-drag-ghost__snippet'
                const oneLine = it.text.replace(/\s+/g, ' ').trim()
                snippet.textContent =
                  oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine || '—'

                ghost.append(titleEl, snippet)
                document.body.appendChild(ghost)
                dragGhostElRef.current = ghost

                const me = e.nativeEvent as MouseEvent
                const ox = Number.isFinite(me.offsetX) ? me.offsetX : 12
                const oy = Number.isFinite(me.offsetY) ? me.offsetY : 12
                e.dataTransfer.setDragImage(ghost, ox, oy)

                card?.classList.add('scm-po__terms-item--drag-source')
              }}
              onDragEnd={() => {
                dragTermIdRef.current = null
                document
                  .querySelectorAll('.scm-po__terms-item--drag-source')
                  .forEach((el) => el.classList.remove('scm-po__terms-item--drag-source'))
                removeDragGhost()
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') ev.preventDefault()
              }}
              aria-label="Drag to reorder"
              title="Drag to reorder"
            >
              ⋮⋮
            </span>
            <label className="scm-po__terms-item-pin scm-po__terms-item-pin--po">
              <input
                type="checkbox"
                checked={it.pinned}
                onChange={(e) => {
                  const on = e.target.checked
                  commit(
                    items.map((x) => (x.id === it.id ? { ...x, pinned: on } : x)),
                  )
                }}
              />{' '}
              Fix
            </label>
            <span className="scm-po__terms-item-idx scm-po__terms-item-idx--po" aria-hidden>
              Point {idx + 1}
            </span>
          </div>
          <textarea
            className="field__control scm-po__textarea scm-po__terms-item-text scm-po__terms-line-text"
            rows={4}
            value={it.text}
            onChange={(e) => {
              const v = e.target.value
              commit(items.map((x) => (x.id === it.id ? { ...x, text: v } : x)))
            }}
            aria-label={`Terms point ${idx + 1}`}
          />
          <div className="scm-po__terms-item-actions">
            <button
              type="button"
              className="btn btn-ghost btn--compact"
              disabled={items.length <= 1}
              onClick={() => {
                if (items.length <= 1) return
                commit(items.filter((x) => x.id !== it.id))
              }}
              aria-label="Remove this point"
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="scm-po__terms-po-add">
        <button
          type="button"
          className="btn btn-ghost btn--compact scm-po__terms-add-point"
          onClick={() => commit([...items, newPoTermLineItem()])}
          aria-label="Add terms point"
          title="Add point"
        >
          <svg
            className="scm-po__terms-add-point-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>Add point</span>
        </button>
      </div>
    </div>
  )
}

function newLine(): ScmPoLine {
  return {
    id: crypto.randomUUID(),
    itemDetails: '',
    partNumber: '',
    hsnCode: '',
    poType: defaultPoType(),
    quantity: '',
    rate: '',
    distributionPct: '',
    tax: '18',
  }
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function computeDistributionChargesInr(form: ScmPoStoredState, subtotalInr: number): number {
  void subtotalInr
  return form.lines.reduce((sum, line) => {
    const pct = parseMoney(String(line.distributionPct ?? '').trim())
    if (!Number.isFinite(pct) || pct <= 0) return sum
    const sub = computeLineSubtotalInr(
      String(line.quantity ?? '').trim(),
      String(line.rate ?? '').trim(),
    )
    if (sub <= 0) return sum
    return sum + (sub * pct) / 100
  }, 0)
}

function buildInitialPoState(
  record: SavedQuoteRecord,
  scmOid: string,
  scmName: string,
): ScmPoStoredState {
  const globalTerms = readScmPoGlobalTerms()
  const existing = record.scmPo
  if (existing) {
    let paymentTermsPreset = existing.paymentTermsPreset
    let paymentTermsDays = existing.paymentTermsDays
    if (!paymentTermsPreset) {
      if ([15, 30, 45, 60].includes(paymentTermsDays)) {
        paymentTermsPreset = String(paymentTermsDays) as ScmPoPaymentPreset
      } else if (paymentTermsDays > 0) {
        paymentTermsPreset = 'custom'
      } else {
        paymentTermsPreset = '30'
        paymentTermsDays = 30
      }
    }
    const withPayment: ScmPoStoredState = {
      ...existing,
      paymentTermsPreset,
      paymentTermsDays,
      termsAndConditions: (() => {
        const base = String(existing.termsAndConditions ?? '').trim()
        const useGlobal = Boolean(existing.termsUseGlobal)
        if (useGlobal) return globalTerms.terms
        return base || globalTerms.terms
      })(),
      termsUseGlobal: false,
    }
    const fromOvfAndQuote = mergeScmPoGapsFromOvfAndQuote(record, withPayment)
    return {
      ...fromOvfAndQuote,
      lines: fromOvfAndQuote.lines.map((l) => normalizeScmPoLine(l)),
    }
  }

  const ovf = record.ovf!
  const f = ovf.fields
  const data = normalizeQuoteFormData(
    record.formSnapshot as QuoteFormData & { customerTitle?: string },
  )
  const commercial = filterCommercialLines(data.lineItems)
  // Default GST for new POs is 18% (SCM can change it on the line items section).
  const gst = '18'
  const vendorUnitByLineId = (f.vendorPurchaseUnitByLineId ?? {}) as Record<
    string,
    string | undefined
  >
  const fromQuote = commercial
    .map((ln) => {
      const prod = ln.product.trim()
      const desc = ln.description.trim()
      const itemDetails = mergeQuoteProductAndDescriptionForItemDetails(
        ln.product,
        ln.description,
      )
      if (!prod && !desc) return null
      return normalizeScmPoLine({
        // Preserve quote line id so we can map to OVF vendor purchase units.
        id: ln.id,
        itemDetails: itemDetails || prod || desc,
        partNumber: prod,
        poType: defaultPoType(),
        quantity: ln.qty,
        // SCM PO should be based on vendor purchase numbers from OVF (not customer sell).
        rate: String(vendorUnitByLineId[ln.id] ?? '').trim(),
        tax: gst,
      })
    })
    .filter(Boolean) as ScmPoLine[]

  const vendorDir = (f.vendorDirectoryId || '').trim()
  const vendorAddrId = (f.vendorAddressId || '').trim()
  const v = vendorDir ? getVendorForUser(vendorDir, record.savedBy) : undefined
  let nameSnap = (f.vendorName || '').trim()
  let addrSnap = (f.vendorAddressDetail || '').trim()
  if (v) {
    if (!nameSnap) nameSnap = v.name.trim()
    if (!addrSnap) {
      const a = vendorAddrId
        ? v.addresses.find((x) => x.id === vendorAddrId)
        : v.addresses[0]
      addrSnap = (a?.lines || '').trim()
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  return {
    poRef: '',
    status: 'draft',
    scmSavedByOid: scmOid,
    scmSavedByDisplayName: scmName,
    createdAt: undefined,
    updatedAt: undefined,
    vendorDirectoryId: vendorDir,
    vendorAddressId: vendorAddrId,
    vendorNameSnapshot: nameSnap,
    vendorAddressSnapshot: addrSnap,
    sourceOfSupply: '',
    destinationOfSupply: '',
    companyLocationId: COMPANY_DELIVERY_LOCATIONS[0]?.id ?? '',
    poCompanyAddress: getScmPoDefaultBillingAddressForPdf(),
    poBillingAddress: getScmPoDefaultBillingAddressForPdf(),
    poShippingAddress: (() => {
      const loc = getCompanyLocationById(
        COMPANY_DELIVERY_LOCATIONS[0]?.id ?? '',
      )
      return (loc?.address ?? '').trim() || getScmPoDefaultBillingAddressForPdf()
    })(),
    purchaseDate: today,
    deliveryDate: '',
    paymentTermsDays: 30,
    paymentTermsPreset: '30',
    distributionChargesMode: 'pct',
    distributionChargesValue: '',
    ovfNumber: ovf.ovfRef,
    quoteNumber: record.quoteRef || data.quoteRef || '',
    companyPoNumber:
      (f.companyPoNumber || '').trim() ||
      allocateNextCompanyPoNumber(
        getCompanyLocationById(COMPANY_DELIVERY_LOCATIONS[0]?.id ?? '')?.poPrefix ?? '',
      ),
    customerPoNumber: (f.customerPoNumber || '').trim(),
    customerPoDate: '',
    ovfApprover: (ovf.financeApprovedBy || '').trim(),
    customerName: (f.customerName || data.customerName || '').trim(),
    customerGstin: String((f as { customerGstin?: string }).customerGstin ?? '').trim(),
    termsAndConditions: globalTerms.terms,
    termsLineItems: parseTermsStringToItems(globalTerms.terms),
    termsUseGlobal: false,
    lines: fromQuote.length > 0 ? fromQuote : [newLine()],
  }
}

function snapshotsFromVendorSelection(
  record: SavedQuoteRecord,
  vendorDirectoryId: string,
  vendorAddressId: string,
): { vendorNameSnapshot: string; vendorAddressSnapshot: string } {
  const v = vendorDirectoryId.trim()
    ? getVendorForUser(vendorDirectoryId.trim(), record.savedBy)
    : undefined
  const name = (v?.name || '').trim()
  const addrRow = v
    ? vendorAddressId.trim()
      ? v.addresses.find((a) => a.id === vendorAddressId.trim())
      : v.addresses[0]
    : undefined
  const addr = (addrRow?.lines || '').trim()
  return {
    vendorNameSnapshot: name,
    vendorAddressSnapshot: addr,
  }
}

export function ScmPoPage() {
  const { quoteId } = useParams<{ quoteId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const [record, setRecord] = useState<SavedQuoteRecord | null | undefined>(undefined)
  const [form, setForm] = useState<ScmPoStoredState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [vendorDirTick, setVendorDirTick] = useState(0)
  const [newVendorName, setNewVendorName] = useState('')
  const [newVendorAddressLines, setNewVendorAddressLines] = useState('')
  const [addVendorError, setAddVendorError] = useState<string | null>(null)
  const [addAddressLines, setAddAddressLines] = useState('')
  const [addAddressError, setAddAddressError] = useState<string | null>(null)
  const [showVendorDirectoryPanel, setShowVendorDirectoryPanel] = useState(false)
  const vendorDirectoryPopoverRef = useRef<HTMLDivElement>(null)
  const [vendorInvoiceAddrScanBusy, setVendorInvoiceAddrScanBusy] = useState(false)
  const [billingAddressEditing, setBillingAddressEditing] = useState(false)
  const [shippingAddressEditing, setShippingAddressEditing] = useState(false)
  const [poAddrPresetVer, setPoAddrPresetVer] = useState(0)
  /** One-time: persist an initial draft so the PO shows in the SCM "Purchase orders" list. */
  const autoSeededPoRef = useRef(false)
  const autoVendorFromInvoiceRef = useRef<string | null>(null)
  /** One attempt per quote to replace placeholder directory address after invoice parse improves. */
  const backfillPlaceholderVendorAddrRef = useRef<string | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const autoDownloadRanRef = useRef(false)

  const customAddressPresets = useMemo(
    () => listPoCompanyAddressPresets(),
    [poAddrPresetVer],
  )

  const reload = useCallback(() => {
    if (!quoteId || !user) {
      setRecord(null)
      setForm(null)
      return
    }
    const r = getSavedQuoteById(quoteId)
    if (!r || !r.ovf) {
      setRecord(null)
      setForm(null)
      return
    }
    if (effectiveOvfWorkflow(r.ovf) !== 'finance_approved') {
      setRecord(null)
      setForm(null)
      return
    }
    setRecord(r)
    setForm(buildInitialPoState(r, user.oid, user.displayName))
  }, [quoteId, user])

  useEffect(() => {
    reload()
  }, [reload, reloadKey])

  useEffect(() => {
    autoSeededPoRef.current = false
    backfillPlaceholderVendorAddrRef.current = null
  }, [quoteId])

  useEffect(() => {
    if (!user || !quoteId || !form) return
    if (autoSeededPoRef.current) return
    if (record == null) return
    if (record.scmPo) {
      autoSeededPoRef.current = true
      return
    }
    if (!record.ovf) return
    if (effectiveOvfWorkflow(record.ovf) !== 'finance_approved') return

    const live = getSavedQuoteById(quoteId)
    if (!live?.ovf) return
    if (live.scmPo) {
      autoSeededPoRef.current = true
      setRecord(live)
      setForm(buildInitialPoState(live, user.oid, user.displayName))
      return
    }

    autoSeededPoRef.current = true
    const snaps = snapshotsFromVendorSelection(
      record,
      form.vendorDirectoryId,
      form.vendorAddressId,
    )
    const next: ScmPoStoredState = {
      ...form,
      poRef: form.poRef.trim(),
      status: 'draft',
      scmSavedByOid: user.oid,
      scmSavedByDisplayName: user.displayName,
      createdAt: new Date().toISOString(),
      vendorNameSnapshot: snaps.vendorNameSnapshot || form.vendorNameSnapshot,
      vendorAddressSnapshot:
        snaps.vendorAddressSnapshot || form.vendorAddressSnapshot,
      lines: form.lines.map((l) => normalizeScmPoLine(l)),
    }
    const saved = updateSavedQuoteScmPo(record.id, next)
    if (saved) {
      setRecord(saved)
      setForm(buildInitialPoState(saved, user.oid, user.displayName))
    } else {
      autoSeededPoRef.current = false
    }
  }, [user, quoteId, record, form])

  const vendors = useMemo(() => {
    if (!record) return []
    const isGarbageVendorName = (name: string): boolean => {
      const t = String(name ?? '').replace(/\s+/g, ' ').trim()
      if (!t) return true
      if (/^(qty|quantity)\s+item\s+description\s+cost$/i.test(t)) return true
      if (/^\d{1,6}\s+\S.{0,80}\s+\d[\d,]*(?:\.\d+)?\s*$/i.test(t)) return true
      if (/\bkailash\s*colony\b/i.test(t)) return true
      return false
    }
    return listVendorsForUser(record.savedBy).filter((v) => !isGarbageVendorName(v.name))
  }, [record, vendorDirTick])

  // Auto-create a vendor directory entry from the vendor invoice / OVF fields
  // so SCM can select it immediately without manual re-entry.
  useEffect(() => {
    if (!record || !form) return
    if (form.vendorDirectoryId.trim()) return
    const f = record.ovf?.fields
    if (!f) return
    const baseName = (f.vendorName || '').trim()
    const baseAddr = (f.vendorAddressDetail || '').trim()
    if (!baseName) return

    let cancelled = false
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

    ;(async () => {
      // If address is missing, try to extract it from the stored vendor invoice attachment.
      let name = baseName
      let addr = baseAddr
      const att = pickVendorInvoiceAttachment(record)
      const vendorAttemptKey =
        att?.dataBase64
          ? `${record.id}:${att.uploadedAt || ''}:${att.fileName || ''}:${att.dataBase64.length}`
          : `${record.id}:no-invoice`
      if (!addr && autoVendorFromInvoiceRef.current !== vendorAttemptKey) {
        autoVendorFromInvoiceRef.current = vendorAttemptKey
        try {
          if (att?.dataBase64) {
            const blob = proofAttachmentBlob(att)
            const file = new File([blob], att.fileName || 'invoice', {
              type: att.mimeType || blob.type || 'application/octet-stream',
            })
            const text = await extractInvoiceRawTextForFooterScan(file)
            const hints = parseVendorPartyFromInvoiceText(text)
            name = (hints.vendorName || name).trim()
            addr = (hints.vendorAddressDetail || addr).trim()
          }
        } catch {
          /* best-effort */
        }
      }

      if (cancelled) return
      if (!name) return
      const looksGarbageName =
        /^(qty|quantity)\s+item\s+description\s+cost$/i.test(name) ||
        /^\d{1,6}\s+\S.{0,80}\s+\d[\d,]*(?:\.\d+)?\s*$/.test(name) ||
        /\bkailash\s*colony\b/i.test(name)
      if (looksGarbageName) return

      const existing = vendors.find((v) => normalize(v.name) === normalize(name))
      const selected = existing
        ? existing
        : createVendorForUser(record.savedBy, name, [
            {
              label: 'Invoice',
              lines: addr || 'Address pending (from vendor invoice).',
            },
          ])
      const first = selected.addresses[0]
      setForm((prev) =>
        prev
          ? {
              ...prev,
              vendorDirectoryId: selected.id,
              vendorAddressId: first?.id ?? '',
              vendorNameSnapshot: (selected.name || '').trim(),
              vendorAddressSnapshot: (first?.lines || '').trim(),
            }
          : prev,
      )
      if (!existing) setVendorDirTick((t) => t + 1)
    })()

    return () => {
      cancelled = true
    }
  }, [record, form, vendors])

  const pendingVendorAddrFromInvoice =
    'Address pending (from vendor invoice).'

  const scanVendorInvoiceForAddress = useCallback(async () => {
    if (!record || !form?.vendorDirectoryId.trim()) return
    if (vendorInvoiceAddrScanBusy) return
    setVendorInvoiceAddrScanBusy(true)
    try {
      const att = pickVendorInvoiceAttachment(record)
      if (!att?.dataBase64) return
      const blob = proofAttachmentBlob(att)
      const file = new File([blob], att.fileName || 'invoice', {
        type: att.mimeType || blob.type || 'application/octet-stream',
      })
      const text = await extractInvoiceRawTextForFooterScan(file)
      const hints = parseVendorPartyFromInvoiceText(text)
      const addr = (hints.vendorAddressDetail || '').trim()
      if (!addr || addr === pendingVendorAddrFromInvoice) return

      const vid = form.vendorDirectoryId.trim()
      const fresh = getVendorForUser(vid, record.savedBy)
      if (!fresh) return
      const aid = form.vendorAddressId.trim()
      const curFresh =
        (aid ? fresh.addresses.find((a) => a.id === aid) : undefined) ??
        fresh.addresses[0]
      if (!curFresh) return
      const nextVendor: VendorEntry = {
        ...fresh,
        addresses: fresh.addresses.map((a) =>
          a.id === curFresh.id ? { ...a, lines: addr } : a,
        ),
      }
      if (!updateVendorForUser(record.savedBy, nextVendor)) return
      setVendorDirTick((t) => t + 1)
      setForm((prev) =>
        prev && prev.vendorAddressId === curFresh.id
          ? { ...prev, vendorAddressSnapshot: addr }
          : prev,
      )
      // Allow a future auto-backfill if the invoice changes again.
      backfillPlaceholderVendorAddrRef.current = null
    } finally {
      setVendorInvoiceAddrScanBusy(false)
    }
  }, [record, form, vendorInvoiceAddrScanBusy])

  useEffect(() => {
    if (!record || !form?.vendorDirectoryId.trim()) return
    const v = getVendorForUser(form.vendorDirectoryId, record.savedBy)
    if (!v) return
    const addrId = form.vendorAddressId.trim()
    const cur =
      (addrId ? v.addresses.find((a) => a.id === addrId) : undefined) ??
      v.addresses[0]
    if (!cur || cur.lines.trim() !== pendingVendorAddrFromInvoice) return
    const att = pickVendorInvoiceAttachment(record)
    const attemptKey =
      att?.dataBase64
        ? `${record.id}:${att.uploadedAt || ''}:${att.fileName || ''}:${att.dataBase64.length}`
        : `${record.id}:no-invoice`
    if (backfillPlaceholderVendorAddrRef.current === attemptKey) return

    let cancelled = false
    ;(async () => {
      backfillPlaceholderVendorAddrRef.current = attemptKey
      try {
        if (!att?.dataBase64) return
        const blob = proofAttachmentBlob(att)
        const file = new File([blob], att.fileName || 'invoice', {
          type: att.mimeType || blob.type || 'application/octet-stream',
        })
        const text = await extractInvoiceRawTextForFooterScan(file)
        const hints = parseVendorPartyFromInvoiceText(text)
        const addr = (hints.vendorAddressDetail || '').trim()
        if (
          !addr ||
          addr === pendingVendorAddrFromInvoice
        ) {
          return
        }
        if (cancelled) return
        const vid = form.vendorDirectoryId.trim()
        const fresh = getVendorForUser(vid, record.savedBy)
        if (!fresh) return
        const aid = form.vendorAddressId.trim()
        const curFresh =
          (aid ? fresh.addresses.find((a) => a.id === aid) : undefined) ??
          fresh.addresses[0]
        if (
          !curFresh ||
          curFresh.lines.trim() !== pendingVendorAddrFromInvoice
        ) {
          return
        }
        const nextVendor: VendorEntry = {
          ...fresh,
          addresses: fresh.addresses.map((a) =>
            a.id === curFresh.id ? { ...a, lines: addr } : a,
          ),
        }
        if (!updateVendorForUser(record.savedBy, nextVendor)) return
        setVendorDirTick((t) => t + 1)
        setForm((prev) =>
          prev && prev.vendorAddressId === curFresh.id
            ? { ...prev, vendorAddressSnapshot: addr }
            : prev,
        )
      } catch {
        /* best-effort */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [record, form])

  const selectedVendor = useMemo(() => {
    if (!record || !form) return undefined
    const id = form.vendorDirectoryId.trim()
    return id ? getVendorForUser(id, record.savedBy) : undefined
  }, [record, form])

  const handleAddVendorToDirectory = useCallback(() => {
    if (!record) return
    setAddVendorError(null)
    const name = newVendorName.trim()
    const lines = newVendorAddressLines.trim()
    if (!name) {
      setAddVendorError('Enter a vendor name.')
      return
    }
    if (!lines) {
      setAddVendorError('Enter the vendor address (multi-line is fine).')
      return
    }
    let created: VendorEntry
    try {
      created = createVendorForUser(record.savedBy, name, [{ label: '', lines }])
    } catch {
      setAddVendorError('Could not save vendor. Try again.')
      return
    }
    const first = created.addresses[0]
    setForm((prev) =>
      prev
        ? {
            ...prev,
            vendorDirectoryId: created.id,
            vendorAddressId: first?.id ?? '',
            vendorNameSnapshot: (created.name || '').trim(),
            vendorAddressSnapshot: (first?.lines || '').trim(),
          }
        : prev,
    )
    setNewVendorName('')
    setNewVendorAddressLines('')
    setVendorDirTick((t) => t + 1)
    setShowVendorDirectoryPanel(false)
    setNotice(`Vendor “${created.name.trim()}” saved to the directory and selected.`)
    window.setTimeout(() => setNotice(null), 6000)
  }, [record, newVendorName, newVendorAddressLines])

  const handleAddAddressToSelectedVendor = useCallback(() => {
    if (!record) return
    setAddAddressError(null)
    const v = selectedVendor
    if (!v) {
      setAddAddressError('Select a vendor first (or add a new vendor below).')
      return
    }
    const lines = addAddressLines.trim()
    if (!lines) {
      setAddAddressError('Enter the new address lines.')
      return
    }
    const newId = crypto.randomUUID()
    const next: VendorEntry = {
      ...v,
      addresses: [
        ...v.addresses,
        { id: newId, label: '', lines },
      ],
    }
    if (!updateVendorForUser(record.savedBy, next)) {
      setAddAddressError('Could not save the new address. Try again.')
      return
    }
    setForm((prev) =>
      prev
        ? {
            ...prev,
            vendorDirectoryId: next.id,
            vendorAddressId: newId,
            vendorNameSnapshot: (next.name || '').trim(),
            vendorAddressSnapshot: lines,
          }
        : prev,
    )
    setAddAddressLines('')
    setVendorDirTick((t) => t + 1)
    setShowVendorDirectoryPanel(false)
    setNotice('New vendor address saved to the directory and selected.')
    window.setTimeout(() => setNotice(null), 6000)
  }, [record, selectedVendor, addAddressLines])

  useEffect(() => {
    if (!showVendorDirectoryPanel) return
    const onPointerDown = (e: PointerEvent) => {
      const root = vendorDirectoryPopoverRef.current
      if (!root || root.contains(e.target as Node)) return
      setShowVendorDirectoryPanel(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowVendorDirectoryPanel(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [showVendorDirectoryPanel])

  const downloadPoPdf = useCallback(async () => {
    if (!form || !record?.scmPo) return
    const el = previewRef.current
    if (!el) return

    await downloadScmPoPdfFromRenderedPreview({
      previewRoot: el,
      filenameBase: form.poRef.trim() || `OVF-${form.ovfNumber}` || 'po',
    })
  }, [form, record])

  useEffect(() => {
    if (!form || !record?.scmPo) return
    if (autoDownloadRanRef.current) return
    if (searchParams.get('download') !== '1') return
    autoDownloadRanRef.current = true
    // Next frame so preview is in the DOM.
    requestAnimationFrame(() => {
      void downloadPoPdf()
    })
  }, [form, record?.scmPo, searchParams, downloadPoPdf])

  // Keep hook order stable across loading -> loaded renders.
  const lineTotals = useMemo(() => {
    if (!form) return { subtotal: 0, gstTotal: 0, dist: 0, grand: 0 }
    let subtotal = 0
    let gstTotal = 0
    for (const l of form.lines) {
      const qty = String(l.quantity ?? '').trim()
      const rate = String(l.rate ?? '').trim()
      if (!qty && !rate) continue
      subtotal += computeLineSubtotalInr(qty, rate)
      gstTotal += computeLineTaxAmountInr(qty, rate, normalizeScmPoLineTaxPct(l.tax))
    }
    const dist = computeDistributionChargesInr(form, subtotal)
    return {
      subtotal,
      gstTotal,
      dist,
      grand: subtotal + gstTotal + dist,
    }
  }, [form])

  const wfOk =
    record &&
    record.ovf &&
    effectiveOvfWorkflow(record.ovf) === 'finance_approved'

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (record === undefined) {
    return (
      <section className="panel scm-po">
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      </section>
    )
  }

  if (!record || !form || !wfOk) {
    return <Navigate to="/scm" replace />
  }

  const setPaymentPreset = (preset: ScmPoPaymentPreset | '') => {
    if (preset === 'custom' || preset === '') {
      setForm((prev) =>
        prev
          ? {
              ...prev,
              paymentTermsPreset: preset === '' ? '' : 'custom',
            }
          : prev,
      )
      return
    }
    const days = Number(preset)
    setForm((prev) =>
      prev
        ? {
            ...prev,
            paymentTermsPreset: preset,
            paymentTermsDays: days,
          }
        : prev,
    )
  }

  const persist = (status: 'draft' | 'final') => {
    const poRef =
      form.poRef.trim() || allocateNextPoRef(user.oid)
    const snaps = snapshotsFromVendorSelection(
      record,
      form.vendorDirectoryId,
      form.vendorAddressId,
    )
    const next: ScmPoStoredState = {
      ...form,
      poRef,
      status,
      scmSavedByOid: user.oid,
      scmSavedByDisplayName: user.displayName,
      createdAt: form.createdAt || new Date().toISOString(),
      vendorNameSnapshot: snaps.vendorNameSnapshot || form.vendorNameSnapshot,
      vendorAddressSnapshot:
        snaps.vendorAddressSnapshot || form.vendorAddressSnapshot,
      lines: form.lines.map((l) => normalizeScmPoLine(l)),
    }
    const saved = updateSavedQuoteScmPo(record.id, next)
    if (!saved) {
      setNotice('Could not save. Try again.')
      return
    }
    if (status === 'final') {
      try {
        const ovf = saved.ovf?.ovfRef?.trim()
        const cust = (saved.scmPo?.customerName || '').trim()
        const msg = [
          `Purchase order ${poRef} has been finalized by SCM.`,
          ovf ? `OVF ${ovf}.` : null,
          cust ? `Customer: ${cust}.` : null,
          'Finance can review this in the workflow when needed.',
        ]
          .filter(Boolean)
          .join(' ')
        sessionStorage.setItem(FINANCE_PO_FINALIZED_NOTICE_KEY, msg)
      } catch {
        /* ignore */
      }
      navigate('/scm', { replace: true })
      return
    }
    setForm(buildInitialPoState(saved, user.oid, user.displayName))
    setNotice(`Draft saved (${poRef}).`)
    setReloadKey((k) => k + 1)
  }

  const globalLineItemsTaxValue = normalizeScmPoLineTaxPct(
    form.lines[0]?.tax ?? '18',
  )
  const lineItemsTaxRatesDiffer = form.lines.some(
    (l) => normalizeScmPoLineTaxPct(l.tax) !== globalLineItemsTaxValue,
  )

  return (
    <section className="panel scm-po">
      <div className="new-quote-layout scm-po__layout">
        <div className="scm-po__main">
      <div className="scm-po__back">
        <Link to="/scm">← SCM workspace</Link>
        <span className="muted scm-po__back-sep" aria-hidden>
          ·
        </span>
        <Link to={`/scm/q/${quoteId}/ovf`} className="link-back">
          View OVF
        </Link>
      </div>

      <header className="scm-po__head">
        <h2 className="scm-po__title">Purchase order</h2>
      </header>

      {notice ? (
        <p className="ovf-entry__banner ovf-entry__banner--ok" role="status">
          {notice}
        </p>
      ) : null}

      <div className="scm-po__grid">
        <div
          className="scm-po__field scm-po__vendor-directory-anchor"
          ref={vendorDirectoryPopoverRef}
        >
          <label className="scm-po__label" htmlFor="scm-po-vendor-select">
            Vendor
          </label>
          <div className="scm-po__vendor-select-row">
            <select
              id="scm-po-vendor-select"
              className="field__control"
              value={form.vendorDirectoryId}
              onChange={(e) => {
                const id = e.target.value
                setForm((prev) => {
                  if (!prev) return prev
                  const v = id ? getVendorForUser(id, record.savedBy) : undefined
                  const firstAddr = v?.addresses[0]
                  return {
                    ...prev,
                    vendorDirectoryId: id,
                    vendorAddressId: firstAddr?.id ?? '',
                    vendorNameSnapshot: (v?.name || '').trim(),
                    vendorAddressSnapshot: (firstAddr?.lines || '').trim(),
                  }
                })
              }}
            >
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn--compact scm-po__vendor-directory-toggle"
              id="scm-po-vendor-directory-toggle"
              aria-expanded={showVendorDirectoryPanel}
              aria-haspopup="true"
              aria-controls="scm-po-vendor-directory"
              disabled={showVendorDirectoryPanel}
              title={
                showVendorDirectoryPanel
                  ? 'Panel open — use Close, click outside, or Escape to dismiss'
                  : 'Add vendor or address to directory'
              }
              aria-label={
                showVendorDirectoryPanel
                  ? 'Vendor directory panel is open; use Close to dismiss'
                  : 'Add vendor or address to directory'
              }
              onClick={() => setShowVendorDirectoryPanel(true)}
            >
              <svg
                className="scm-po__vendor-directory-toggle-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>

          {showVendorDirectoryPanel ? (
            <div
              className="scm-po__vendor-manual scm-po__vendor-manual--popover"
              id="scm-po-vendor-directory"
              role="region"
              aria-labelledby="scm-po-vendor-directory-title"
            >
              <div className="scm-po__vendor-manual__title-row">
                <p className="scm-po__label scm-po__vendor-manual__title-text" id="scm-po-vendor-directory-title">
                  Vendor directory (SCM)
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn--compact scm-po__vendor-manual__close"
                  onClick={() => setShowVendorDirectoryPanel(false)}
                  aria-label="Close vendor directory panel"
                >
                  Close
                </button>
              </div>
              <p className="muted scm-po__vendor-manual__hint">
                If the vendor or address is missing from the list, add it here. This saves to the same
                vendor directory as this quote and selects it for this PO.
              </p>

              {addAddressError ? (
                <p className="scm-po__form-error" role="alert">
                  {addAddressError}
                </p>
              ) : null}

              <label className="scm-po__field scm-po__field--wide">
                <span className="scm-po__label">Add address to selected vendor</span>
                <textarea
                  className="field__control scm-po__textarea"
                  rows={3}
                  value={addAddressLines}
                  onChange={(e) => setAddAddressLines(e.target.value)}
                  placeholder="Paste the full address (multi-line is fine)…"
                  disabled={!selectedVendor}
                />
              </label>
              <div className="scm-po__vendor-manual__actions">
                <button
                  type="button"
                  className="btn btn-ghost btn--compact"
                  onClick={handleAddAddressToSelectedVendor}
                  disabled={!selectedVendor}
                >
                  Save address to directory &amp; select
                </button>
              </div>

              {addVendorError ? (
                <p className="scm-po__form-error" role="alert">
                  {addVendorError}
                </p>
              ) : null}

              <label className="scm-po__field">
                <span className="scm-po__label">New vendor name</span>
                <input
                  type="text"
                  className="field__control"
                  value={newVendorName}
                  onChange={(e) => setNewVendorName(e.target.value)}
                  autoComplete="organization"
                  placeholder="Company name"
                />
              </label>
              <label className="scm-po__field scm-po__field--wide">
                <span className="scm-po__label">New vendor address</span>
                <textarea
                  className="field__control scm-po__textarea"
                  rows={4}
                  value={newVendorAddressLines}
                  onChange={(e) => setNewVendorAddressLines(e.target.value)}
                  placeholder="Full address (multi-line is fine)…"
                />
              </label>
              <div className="scm-po__vendor-manual__actions">
                <button
                  type="button"
                  className="btn btn-ghost btn--compact"
                  onClick={handleAddVendorToDirectory}
                >
                  Save new vendor to directory &amp; select
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Vendor address for this PO</span>
          <select
            className="field__control"
            disabled={!selectedVendor}
            value={form.vendorAddressId}
            onChange={(e) => {
              const addrId = e.target.value
              setForm((prev) => {
                if (!prev || !selectedVendor) return prev
                const row = selectedVendor.addresses.find((a) => a.id === addrId)
                return {
                  ...prev,
                  vendorAddressId: addrId,
                  vendorAddressSnapshot: (row?.lines || '').trim(),
                  vendorNameSnapshot: (selectedVendor.name || '').trim(),
                }
              })
            }}
          >
            {!selectedVendor ? (
              <option value="">Choose a vendor first</option>
            ) : (
              selectedVendor.addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatVendorAddressForSelectOption(a)}
                </option>
              ))
            )}
          </select>
          {selectedVendor && form.vendorAddressId ? (
            <pre className="scm-po__address-preview muted" aria-live="polite">
              {(selectedVendor.addresses.find((a) => a.id === form.vendorAddressId)?.lines || '').trim() ||
                '—'}
            </pre>
          ) : null}
          {selectedVendor && form.vendorAddressId ? (
            (() => {
              const lines =
                (selectedVendor.addresses.find((a) => a.id === form.vendorAddressId)?.lines || '').trim()
              if (lines !== pendingVendorAddrFromInvoice) return null
              return (
                <button
                  type="button"
                  className="btn btn-ghost btn--compact"
                  onClick={() => void scanVendorInvoiceForAddress()}
                  disabled={vendorInvoiceAddrScanBusy}
                  style={{ marginTop: '0.35rem' }}
                  title="Try scanning the vendor invoice again for address lines"
                >
                  {vendorInvoiceAddrScanBusy ? 'Scanning invoice…' : 'Re-scan invoice for address'}
                </button>
              )
            })()
          ) : null}
        </label>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Source of supply</span>
          <input
            type="text"
            className="field__control"
            value={form.sourceOfSupply}
            onChange={(e) =>
              setForm((p) => (p ? { ...p, sourceOfSupply: e.target.value } : p))
            }
          />
        </label>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Destination of supply</span>
          <input
            type="text"
            className="field__control"
            value={form.destinationOfSupply}
            onChange={(e) =>
              setForm((p) =>
                p ? { ...p, destinationOfSupply: e.target.value } : p,
              )
            }
          />
        </label>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Our company location</span>
          <select
            className="field__control"
            value={form.companyLocationId}
            onChange={(e) => {
              const id = e.target.value
              setForm((p) => {
                if (!p) return p
                const loc = getCompanyLocationById(id)
                const addr = (loc?.address ?? '').trim()
                return {
                  ...p,
                  companyLocationId: id,
                  poCompanyAddress: addr || p.poCompanyAddress,
                  companyPoNumber: nextCompanyPoNumberForLocation(
                    p.companyPoNumber,
                    id,
                  ),
                }
              })
            }}
          >
            {COMPANY_DELIVERY_LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Company address</span>
          <textarea
            className="field__control scm-po__textarea"
            rows={5}
            value={form.poCompanyAddress ?? ''}
            onChange={(e) =>
              setForm((p) => (p ? { ...p, poCompanyAddress: e.target.value } : p))
            }
            aria-label="Company header address on purchase order"
          />
        </label>

        <ScmPoAddressPresetField
          label="Billing address"
          idBase="billing"
          rows={4}
          ariaLabel="Billing address on purchase order"
          value={form.poBillingAddress ?? ''}
          editing={billingAddressEditing}
          onToggleEdit={() => setBillingAddressEditing((e) => !e)}
          onChange={(v) => setForm((p) => (p ? { ...p, poBillingAddress: v } : p))}
          customPresets={customAddressPresets}
          onRegisterNewPreset={(name, addr) => {
            const p = addPoCompanyAddressPreset(name, addr)
            if (!p) {
              return 'Enter a display name and the full address.'
            }
            setForm((f) => (f ? { ...f, poBillingAddress: p.address } : f))
            setPoAddrPresetVer((n) => n + 1)
            return null
          }}
        />

        <ScmPoAddressPresetField
          label="Shipping address"
          idBase="shipping"
          rows={4}
          ariaLabel="Shipping address on purchase order"
          value={form.poShippingAddress ?? ''}
          editing={shippingAddressEditing}
          onToggleEdit={() => setShippingAddressEditing((e) => !e)}
          onChange={(v) => setForm((p) => (p ? { ...p, poShippingAddress: v } : p))}
          customPresets={customAddressPresets}
          onRegisterNewPreset={(name, addr) => {
            const p = addPoCompanyAddressPreset(name, addr)
            if (!p) {
              return 'Enter a display name and the full address.'
            }
            setForm((f) => (f ? { ...f, poShippingAddress: p.address } : f))
            setPoAddrPresetVer((n) => n + 1)
            return null
          }}
        />

        <label className="scm-po__field">
          <span className="scm-po__label">Purchase date</span>
          <input
            type="date"
            className="field__control"
            value={form.purchaseDate}
            onChange={(e) =>
              setForm((p) => (p ? { ...p, purchaseDate: e.target.value } : p))
            }
          />
        </label>

        <label className="scm-po__field">
          <span className="scm-po__label">Delivery date</span>
          <input
            type="date"
            className="field__control"
            value={form.deliveryDate}
            onChange={(e) =>
              setForm((p) => (p ? { ...p, deliveryDate: e.target.value } : p))
            }
          />
        </label>

        <label className="scm-po__field">
          <span className="scm-po__label">Payment terms</span>
          <select
            className="field__control"
            value={
              ['15', '30', '45', '60'].includes(form.paymentTermsPreset)
                ? form.paymentTermsPreset
                : 'custom'
            }
            onChange={(e) => {
              const v = e.target.value
              if (v === 'custom') setPaymentPreset('custom')
              else setPaymentPreset(v as ScmPoPaymentPreset)
            }}
          >
            <option value="15">Net 15</option>
            <option value="30">Net 30</option>
            <option value="45">Net 45</option>
            <option value="60">Net 60</option>
            <option value="custom">Custom (days)</option>
          </select>
        </label>

        {form.paymentTermsPreset === 'custom' ? (
          <label className="scm-po__field">
            <span className="scm-po__label">Days (manual)</span>
            <input
              type="number"
              min={0}
              className="field__control"
              value={Number.isFinite(form.paymentTermsDays) ? form.paymentTermsDays : 0}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                setForm((p) =>
                  p
                    ? {
                        ...p,
                        paymentTermsDays: Number.isFinite(n) ? Math.max(0, n) : 0,
                      }
                    : p,
                )
              }}
            />
          </label>
        ) : null}

        <div className="scm-po__field scm-po__readonly">
          <span className="scm-po__label">OVF number</span>
          <p className={form.ovfNumber.trim() ? 'scm-ovf-ref' : undefined}>
            {form.ovfNumber.trim() || '—'}
          </p>
        </div>
        <div className="scm-po__field scm-po__readonly">
          <span className="scm-po__label">Quote number</span>
          <p>{form.quoteNumber || '—'}</p>
        </div>

        <div className="scm-po__field scm-po__readonly">
          <span className="scm-po__label">Company PO number</span>
          <p>{form.companyPoNumber.trim() || '—'}</p>
        </div>

        <label className="scm-po__field">
          <span className="scm-po__label">Customer PO number</span>
          <input
            type="text"
            className="field__control"
            value={form.customerPoNumber}
            onChange={(e) =>
              setForm((p) =>
                p ? { ...p, customerPoNumber: e.target.value } : p,
              )
            }
          />
        </label>

        <label className="scm-po__field">
          <span className="scm-po__label">Customer PO date</span>
          <input
            type="date"
            className="field__control"
            value={form.customerPoDate}
            onChange={(e) =>
              setForm((p) =>
                p ? { ...p, customerPoDate: e.target.value } : p,
              )
            }
          />
        </label>

        <div className="scm-po__field scm-po__readonly">
          <span className="scm-po__label">OVF approver</span>
          <p>{form.ovfApprover || '—'}</p>
        </div>

        <div className="scm-po__field scm-po__readonly scm-po__field--wide">
          <span className="scm-po__label">Customer name</span>
          <p>{form.customerName || '—'}</p>
        </div>

        <label className="scm-po__field scm-po__field--wide">
          <span className="scm-po__label">Customer GSTIN</span>
          <input
            type="text"
            className="field__control"
            value={form.customerGstin ?? ''}
            onChange={(e) =>
              setForm((p) => (p ? { ...p, customerGstin: e.target.value } : p))
            }
            placeholder="15 characters (e.g. 07ABCDE1234F1Z5)"
          />
        </label>
      </div>

      <fieldset className="scm-po__lines">
        <legend className="scm-po__legend">Line items</legend>
        <div className="scm-po__lines-global-tax">
          <label
            className="scm-po__lines-global-tax-label"
            htmlFor="scm-po-global-line-tax"
          >
            <span className="scm-po__label">Tax %</span>
            <select
              id="scm-po-global-line-tax"
              className="field__control scm-po__lines-global-tax-select"
              value={globalLineItemsTaxValue}
              onChange={(e) => {
                const v = e.target.value
                setForm((p) => {
                  if (!p) return p
                  return {
                    ...p,
                    lines: p.lines.map((x) => ({ ...x, tax: v })),
                  }
                })
              }}
              aria-describedby={
                lineItemsTaxRatesDiffer ? 'scm-po-global-line-tax-hint' : undefined
              }
            >
              {SCM_PO_TAX_PERCENT_OPTIONS.map((pct) => (
                <option key={pct} value={pct}>
                  {pct}%
                </option>
              ))}
            </select>
          </label>
          {lineItemsTaxRatesDiffer ? (
            <p
              id="scm-po-global-line-tax-hint"
              className="muted scm-po__lines-global-tax-note"
            >
              Line tax values differ; pick a rate here to set the same tax on every
              line.
            </p>
          ) : null}
        </div>
        <div className="scm-po__lines-panel">
          <div className="scm-po__lines-scroll">
            <table className="scm-po__table scm-po__table--lines">
              <thead>
                <tr>
                  <th scope="col" className="scm-po__th--narrow">
                    #
                  </th>
                  <th scope="col">Item details</th>
                  <th scope="col">Part number</th>
                  <th scope="col">HSN code</th>
                  <th scope="col">PO type</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Rate (INR)</th>
                  <th scope="col" className="scm-po__th--num">
                    Distributor
                  </th>
                  <th scope="col">Tax %</th>
                  <th scope="col" className="scm-po__th--num">
                    Amount total (INR)
                  </th>
                  <th scope="col" className="scm-po__th-actions" />
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, idx) => {
                  const total = computeLineTotalInr(
                    line.quantity,
                    line.rate,
                    normalizeScmPoLineTaxPct(line.tax),
                  )
                  const showTotal =
                    line.quantity.trim() || line.rate.trim()
                      ? formatInrScm(total)
                      : '—'
                  const patchLine = (patch: Partial<ScmPoLine>) => {
                    setForm((p) => {
                      if (!p) return p
                      const lines = p.lines.map((x) =>
                        x.id === line.id ? { ...x, ...patch } : x,
                      )
                      return { ...p, lines }
                    })
                  }
                  return (
                    <tr key={line.id}>
                      <td>{idx + 1}</td>
                      <td>
                        <ScmPoLineDetailsTextarea
                          value={line.itemDetails}
                          onChange={(v) => patchLine({ itemDetails: v })}
                          aria-label="Item details"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="field__control"
                          value={line.partNumber}
                          onChange={(e) =>
                            patchLine({ partNumber: e.target.value })
                          }
                          aria-label="Part number"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="field__control scm-po__input--hsn"
                          value={line.hsnCode}
                          onChange={(e) =>
                            patchLine({ hsnCode: e.target.value })
                          }
                          placeholder="HSN / SAC"
                          aria-label="HSN code"
                        />
                      </td>
                      <td>
                        <select
                          className="field__control"
                          value={line.poType}
                          onChange={(e) => patchLine({ poType: e.target.value })}
                          aria-label="PO type"
                        >
                          {SCM_PO_TYPE_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          className="field__control scm-po__input--num"
                          value={line.quantity}
                          onChange={(e) =>
                            patchLine({ quantity: e.target.value })
                          }
                          aria-label="Quantity"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="field__control scm-po__input--num"
                          value={line.rate}
                          onChange={(e) => patchLine({ rate: e.target.value })}
                          aria-label="Rate INR"
                        />
                      </td>
                      <td className="scm-po__td--num">
                        <input
                          type="text"
                          className="field__control scm-po__input--num"
                          inputMode="decimal"
                          placeholder="%"
                          value={String(line.distributionPct ?? '')}
                          onChange={(e) => patchLine({ distributionPct: e.target.value })}
                          aria-label="Distribution percent"
                        />
                      </td>
                      <td>
                        <select
                          className="field__control scm-po__input--num"
                          value={normalizeScmPoLineTaxPct(line.tax)}
                          onChange={(e) => {
                            const v = e.target.value
                            if (idx === 0) {
                              setForm((p) => {
                                if (!p) return p
                                return {
                                  ...p,
                                  lines: p.lines.map((x) => ({ ...x, tax: v })),
                                }
                              })
                            } else {
                              patchLine({ tax: v })
                            }
                          }}
                          aria-label={
                            idx === 0
                              ? 'Tax % (GST) — applies to every line'
                              : 'Tax % (GST)'
                          }
                        >
                          {SCM_PO_TAX_PERCENT_OPTIONS.map((pct) => (
                            <option key={pct} value={pct}>
                              {pct}%
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="scm-po__td--num">{showTotal}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn--compact"
                          disabled={form.lines.length <= 1}
                          onClick={() =>
                            setForm((p) => {
                              if (!p || p.lines.length <= 1) return p
                              return {
                                ...p,
                                lines: p.lines.filter((x) => x.id !== line.id),
                              }
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="scm-po__lines-toolbar scm-po__lines-toolbar--below">
          <button
            type="button"
            className="btn btn-ghost btn--compact scm-po__add-line"
            onClick={() =>
              setForm((p) => {
                if (!p) return p
                const line = newLine()
                const refTax = p.lines[p.lines.length - 1]?.tax
                const t = String(refTax ?? '').trim()
                if (t) line.tax = t
                return { ...p, lines: [...p.lines, line] }
              })
            }
            aria-label="Add line item"
          >
            <svg
              className="scm-po__add-line-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Add line</span>
          </button>
        </div>

        <div className="scm-po__lines-summary" aria-label="Line item totals">
          <div className="scm-po__lines-summary-row">
            <span className="scm-po__lines-summary-k">Subtotal (INR)</span>
            <span className="scm-po__lines-summary-v">{formatInrScm(lineTotals.subtotal)}</span>
          </div>
          <div className="scm-po__lines-summary-row">
            <span className="scm-po__lines-summary-k">Distributor charges</span>
            <span className="scm-po__lines-summary-v">{formatInrScm(lineTotals.dist)}</span>
          </div>
          <div className="scm-po__lines-summary-row">
            <span className="scm-po__lines-summary-k">GST total (INR)</span>
            <span className="scm-po__lines-summary-v">{formatInrScm(lineTotals.gstTotal)}</span>
          </div>
          <div className="scm-po__lines-summary-row scm-po__lines-summary-row--grand">
            <span className="scm-po__lines-summary-k">Grand total (INR)</span>
            <span className="scm-po__lines-summary-v">{formatInrScm(lineTotals.grand)}</span>
          </div>
        </div>
      </fieldset>

      <fieldset className="scm-po__terms">
        <legend className="scm-po__legend">Terms &amp; conditions</legend>

        <ScmPoTermsLinesEditor
          key={`${quoteId ?? ''}-${reloadKey}`}
          value={form.termsAndConditions}
          lineItems={form.termsLineItems}
          onChange={(next) =>
            setForm((p) =>
              p
                ? {
                    ...p,
                    termsAndConditions: next.termsAndConditions,
                    termsLineItems: next.termsLineItems,
                  }
                : p,
            )
          }
        />
      </fieldset>

      <div className="scm-po__actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => persist('draft')}
        >
          Save as draft
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => persist('final')}
        >
          Save PO
        </button>
      </div>
        </div>

        <aside className="new-quote-preview card-surface scm-po__preview-aside" aria-label="PO document preview">
          <div className="new-quote-preview__head">
            <h3 className="new-quote-preview__title">PO preview</h3>
            <span className="preview-pill preview-pill--live">Live</span>
          </div>
          <div ref={previewRef} className="pdf-preview pdf-preview--html scm-po__preview-shell">
            <ScmPoDocumentPreview form={form} />
          </div>
        </aside>
      </div>
    </section>
  )
}
