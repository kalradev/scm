import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { getCompanyLocationById } from '../lib/companyLocations'
import {
  SCM_PO_LETTERHEAD,
  getScmPoDefaultBillingAddressForPdf,
} from '../lib/scmPoLetterhead'
import { formatInrAmountWords } from '../lib/inrAmountWords'
import {
  computeLineSubtotalInr,
  computeLineTaxAmountInr,
  formatInrScm,
  normalizeScmPoLineTaxPct,
} from '../lib/scmPoLine'
import { buildTermSegments, isNumberedBlockWithContinuations } from '../lib/quotePdfTemplate'
import type { ScmPoStoredState } from '../types/scmPo'

/** Shown at the end of page 2 after Terms & Conditions (also when that line is not in the editable terms text). */
const SCM_PO_ELECTRONIC_NOTICE =
  'THIS IS AN ELECTRONICALLY GENERATED PURCHASE ORDER AND DOES NOT REQUIRE SIGNATURE'

/** Matches `scm-po-doc-preview__sheet` width and `scmPoPdf` html2canvas `windowWidth`. */
const SCM_PO_PREVIEW_BASE_WIDTH = 860

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

function assetUrl(name: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}${name}`
}

function formatPurchaseDate(iso: string): string {
  const t = String(iso ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return '—'
  const [y, m, d] = t.split('-')
  return `${d}/${m}/${y}`
}

function oneLineAddress(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripBranchTagFromCompanyName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/^(CT|CDT)(?:\s+|\/)\s*/i, '')
    .trim()
}

function splitPoCompanyHeader(raw: string): { name: string; lines: string[]; phoneLine?: string } {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return {
      name: SCM_PO_LETTERHEAD.legalName,
      lines: [...SCM_PO_LETTERHEAD.registeredAddressLines],
      phoneLine: SCM_PO_LETTERHEAD.phone,
    }
  }

  const last = lines[lines.length - 1] ?? ''
  const hasTel = /^tel:/i.test(last)
  const body = hasTel ? lines.slice(0, -1) : lines
  const phoneLine = hasTel ? last : undefined

  const name = stripBranchTagFromCompanyName(body[0] ?? SCM_PO_LETTERHEAD.legalName)
  const rest = body.slice(1)

  return { name, lines: rest, phoneLine }
}

function displayOrDash(v: string): string {
  const s = String(v ?? '').trim()
  return s || '—'
}

function formatQtyCell(qty: string): string {
  const raw = String(qty ?? '').trim().replace(/,/g, '')
  if (!raw) return '—'
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return raw
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function lineHasAmounts(qty: string, rate: string): boolean {
  return Boolean(String(qty ?? '').trim() || String(rate ?? '').trim())
}

type Props = {
  form: ScmPoStoredState
}

export function ScmPoDocumentPreview({ form }: Props) {
  const showHsnCode = form.lines.some((l) => String(l.hsnCode ?? '').trim() !== '')
  const sameSupplyLocation =
    String(form.sourceOfSupply ?? '').trim().toLowerCase() !== '' &&
    String(form.sourceOfSupply ?? '').trim().toLowerCase() ===
      String(form.destinationOfSupply ?? '').trim().toLowerCase()
  const loc = getCompanyLocationById(form.companyLocationId)
  const companyTag = loc?.poPrefix || ''
  const companyHeaderRaw =
    (form.poCompanyAddress ?? '').trim() || getScmPoDefaultBillingAddressForPdf()
  const companyHeader = splitPoCompanyHeader(companyHeaderRaw)
  const billingBlock =
    (form.poBillingAddress ?? '').trim() || getScmPoDefaultBillingAddressForPdf()
  const shippingBlock =
    (form.poShippingAddress ?? '').trim() ||
    (loc?.address ?? '').trim() ||
    getScmPoDefaultBillingAddressForPdf()
  const billingPdfDisplay = billingBlock.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const shippingPdfDisplay = shippingBlock.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const paymentLabel =
    form.paymentTermsDays > 0
      ? `Net ${form.paymentTermsDays} Days`
      : '—'

  /** From ship-from company location; letterhead default if omitted. Not editable on the PO form. */
  const headerGstNo = (loc?.gstNo ?? '').trim() || SCM_PO_LETTERHEAD.gstNo
  const headerPanNo = (loc?.panNo ?? '').trim() || SCM_PO_LETTERHEAD.panNo
  const headerServiceTaxNo =
    (loc?.serviceTaxNo ?? '').trim() || SCM_PO_LETTERHEAD.serviceTaxNo

  const cacheOrderNoRaw = form.companyPoNumber.trim()
  const cacheOrderNoParts = (() => {
    if (!cacheOrderNoRaw) return { prefix: '', base: '—' }
    const m = cacheOrderNoRaw.match(/^(CT|CDT)\/(.+)$/i)
    if (m) return { prefix: m[1].toUpperCase(), base: m[2] }
    // Back-compat: older saved values were `PO/YY-YY/NNN` with no CT/CDT prefix.
    return { prefix: companyTag, base: cacheOrderNoRaw }
  })()

  let subtotalInr = 0
  const taxByRate = new Map<string, number>()

  const lineRows = form.lines.map((line, idx) => {
    const tax = normalizeScmPoLineTaxPct(line.tax)
    const counts = lineHasAmounts(line.quantity, line.rate)
    const sub = counts ? computeLineSubtotalInr(line.quantity, line.rate) : 0
    const taxAmt = counts ? computeLineTaxAmountInr(line.quantity, line.rate, tax) : 0
    if (counts) {
      subtotalInr += sub
      taxByRate.set(tax, (taxByRate.get(tax) ?? 0) + taxAmt)
    }
    const lineTotalPreTax = counts ? formatInrScm(sub) : '—'

    return (
      <tr key={line.id}>
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--cen">
          {idx + 1}
        </td>
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--part">
          {displayOrDash(line.partNumber)}
        </td>
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--desc">
          {line.itemDetails.trim() ? (
            <span className="scm-po-doc-preview__pre-wrap">{line.itemDetails.trim()}</span>
          ) : (
            '—'
          )}
        </td>
        {showHsnCode ? (
          <td className="scm-po-doc-preview__td scm-po-doc-preview__td--cen">
            {String(line.hsnCode ?? '').trim()}
          </td>
        ) : null}
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--cen">
          {formatQtyCell(line.quantity)}
        </td>
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num">
          <span className="scm-po-doc-preview__cell-num">
            {counts ? formatInrScm(parseMoney(line.rate)) : '—'}
          </span>
        </td>
        <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num">
          <span className="scm-po-doc-preview__cell-num">{lineTotalPreTax}</span>
        </td>
      </tr>
    )
  })

  const totalTaxInr = [...taxByRate.values()].reduce((a, b) => a + b, 0)
  const distributionChargesInr = computeDistributionChargesInr(form, subtotalInr)
  const poGrand = subtotalInr + totalTaxInr + distributionChargesInr

  const taxSummaryRows = [...taxByRate.entries()]
    .sort((a, b) => Number.parseFloat(b[0]) - Number.parseFloat(a[0]))
    .flatMap(([pct, amt]) => {
      const colSpan = showHsnCode ? 5 : 4
      const pctNum = Number.parseFloat(pct)
      const half = Number.isFinite(pctNum) ? pctNum / 2 : pctNum
      const halfLabel =
        Number.isFinite(half) && Math.abs(half - Math.round(half)) < 1e-9
          ? String(Math.round(half))
          : Number.isFinite(half)
            ? half.toFixed(2).replace(/\.?0+$/, '')
            : pct

      const mkRow = (key: string, label: string, value: number) => (
        <tr key={key}>
          <td
            colSpan={colSpan}
            className="scm-po-doc-preview__td scm-po-doc-preview__td--summary-spacer"
          />
          <td className="scm-po-doc-preview__td scm-po-doc-preview__summary-label scm-po-doc-preview__td--cen">
            {label}
          </td>
          <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num scm-po-doc-preview__td--summary-val">
            <span className="scm-po-doc-preview__cell-num">{formatInrScm(value)}</span>
          </td>
        </tr>
      )

      if (sameSupplyLocation) {
        const halfAmt = amt / 2
        return [
          mkRow(`tax-${pct}-cgst`, `CGST${halfLabel} (${halfLabel}%)`, halfAmt),
          mkRow(`tax-${pct}-sgst`, `SGST${halfLabel} (${halfLabel}%)`, halfAmt),
        ]
      }
      return [mkRow(`tax-${pct}-igst`, `IGST${pct} (${pct}%)`, amt)]
    })

  const termLinesRaw = (form.termsAndConditions || '').trim()
    ? form.termsAndConditions.split(/\r?\n/)
    : ['—']
  const footerRe =
    /THIS IS AN ELECTRONICALLY GENERATED PURCHASE ORDER AND DOES NOT REQUIRE SIGNATURE/i
  const termLines = termLinesRaw.filter(
    (l) => !footerRe.test(String(l || '').trim()),
  )

  const termSegments = buildTermSegments(termLines)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scaleInnerRef = useRef<HTMLDivElement | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [scaledStackH, setScaledStackH] = useState(0)

  const updatePreviewFit = useCallback(() => {
    const scroll = scrollRef.current
    const inner = scaleInnerRef.current
    if (!scroll || !inner) return
    const pad = 10
    const cw = Math.max(120, scroll.clientWidth - pad)
    const next = Math.min(1, cw / SCM_PO_PREVIEW_BASE_WIDTH)
    setPreviewScale(next)
    setScaledStackH(inner.offsetHeight)
  }, [])

  useLayoutEffect(() => {
    const run = () => updatePreviewFit()
    run()
    requestAnimationFrame(run)
    const scroll = scrollRef.current
    const inner = scaleInnerRef.current
    if (!scroll || !inner) return
    const ro = new ResizeObserver(() => {
      updatePreviewFit()
    })
    ro.observe(scroll)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [updatePreviewFit])

  const shrinkPreview = previewScale < 0.999
  const fitBoxStyle =
    shrinkPreview && scaledStackH > 0
      ? {
          width: SCM_PO_PREVIEW_BASE_WIDTH * previewScale,
          height: scaledStackH * previewScale,
        }
      : undefined
  const scaleInnerStyle = shrinkPreview
    ? {
        transform: `scale(${previewScale})` as const,
        transformOrigin: 'top left' as const,
        width: SCM_PO_PREVIEW_BASE_WIDTH,
      }
    : undefined

  return (
    <div className="scm-po-doc-preview">
      <div ref={scrollRef} className="scm-po-doc-preview__scroll">
        <div className="scm-po-doc-preview__fit" style={fitBoxStyle}>
          <div ref={scaleInnerRef} className="scm-po-doc-preview__scale-inner" style={scaleInnerStyle}>
        <article className="scm-po-doc-preview__sheet" aria-label="Purchase order page 1">
          <table className="scm-po-doc-preview__table scm-po-doc-preview__table--outer">
            <colgroup>
              <col className="scm-po-doc-preview__outer-col scm-po-doc-preview__outer-col--left" />
              <col className="scm-po-doc-preview__outer-col scm-po-doc-preview__outer-col--right" />
            </colgroup>
            <tbody>
              <tr>
                <td colSpan={2} className="scm-po-doc-preview__banner">
                  PURCHASE ORDER
                </td>
              </tr>
              <tr>
                <td className="scm-po-doc-preview__cell scm-po-doc-preview__cell--logo">
                  <div className="scm-po-doc-preview__logo-wrap">
                    <img
                      className="scm-po-doc-preview__logo"
                      src={assetUrl('cache1.png')}
                      alt=""
                      onError={(e) => {
                        const el = e.currentTarget
                        if (!el.dataset.fallback) {
                          el.dataset.fallback = '1'
                          el.src = assetUrl('cache-logo.png')
                        }
                      }}
                    />
                  </div>
                </td>
                <td className="scm-po-doc-preview__cell scm-po-doc-preview__cell--company">
                  <p className="scm-po-doc-preview__company-name">
                    {companyHeader.name}
                  </p>
                  {companyHeader.lines.map((line, i) => (
                    <p key={i} className="scm-po-doc-preview__company-addr">
                      {line}
                    </p>
                  ))}
                  <p className="scm-po-doc-preview__company-addr">
                    {companyHeader.phoneLine ?? SCM_PO_LETTERHEAD.phone}
                  </p>
                </td>
              </tr>
              <tr>
                <td className="scm-po-doc-preview__cell scm-po-doc-preview__cell--top">
                  <p className="scm-po-doc-preview__label">Supplier:</p>
                  <p className="scm-po-doc-preview__strong">
                    {displayOrDash(form.vendorNameSnapshot)}
                  </p>
                  <p className="scm-po-doc-preview__block-text">
                    {oneLineAddress(form.vendorAddressSnapshot) || '—'}
                  </p>
                  <p className="scm-po-doc-preview__gstin">
                    <span className="scm-po-doc-preview__label">Customer GSTIN:</span>{' '}
                    <span className="scm-po-doc-preview__muted">
                      {String(form.customerGstin ?? '').trim() || '—'}
                    </span>
                  </p>
                </td>
                <td className="scm-po-doc-preview__cell scm-po-doc-preview__cell--top">
                  <p className="scm-po-doc-preview__kv">
                    <span className="scm-po-doc-preview__label">GST NO:</span>
                    <span className="scm-po-doc-preview__kv-val">{headerGstNo}</span>
                  </p>
                  <p className="scm-po-doc-preview__kv">
                    <span className="scm-po-doc-preview__label">PAN NO:</span>
                    <span className="scm-po-doc-preview__kv-val">{headerPanNo}</span>
                  </p>
                  <p className="scm-po-doc-preview__kv">
                    <span className="scm-po-doc-preview__label">Service Tax No.:</span>
                    <span className="scm-po-doc-preview__kv-val">
                      {headerServiceTaxNo}
                    </span>
                  </p>
                  <p className="scm-po-doc-preview__kv">
                    <span className="scm-po-doc-preview__label">Order Ref. Cache:</span>
                    <span className="scm-po-doc-preview__kv-val" />
                  </p>
                  <p className="scm-po-doc-preview__kv scm-po-doc-preview__kv--cache-order">
                    <span className="scm-po-doc-preview__label">CACHE Order No.:</span>
                    {cacheOrderNoParts.prefix ? (
                      <span className="scm-po-doc-preview__po-prefix">{cacheOrderNoParts.prefix}</span>
                    ) : null}
                    <span className="scm-po-doc-preview__po-base">{cacheOrderNoParts.base}</span>
                  </p>
                  <p className="scm-po-doc-preview__kv">
                    <span className="scm-po-doc-preview__label">Date:</span>
                    <span className="scm-po-doc-preview__kv-val">
                      {formatPurchaseDate(form.purchaseDate)}
                    </span>
                  </p>
                </td>
              </tr>
              <tr>
                <td colSpan={2} className="scm-po-doc-preview__cell scm-po-doc-preview__cell--flush">
                  <table className="scm-po-doc-preview__table scm-po-doc-preview__table--quad">
                    <tbody>
                      <tr>
                        <td className="scm-po-doc-preview__quad-cell">
                          <p className="scm-po-doc-preview__label">Billing Address:</p>
                          <p className="scm-po-doc-preview__block-text scm-po-doc-preview__pre-wrap">
                            {billingPdfDisplay}
                          </p>
                        </td>
                        <td className="scm-po-doc-preview__quad-cell">
                          <p className="scm-po-doc-preview__label">Shipping Address:</p>
                          <p className="scm-po-doc-preview__block-text scm-po-doc-preview__pre-wrap">
                            {shippingPdfDisplay}
                          </p>
                        </td>
                        <td className="scm-po-doc-preview__quad-cell scm-po-doc-preview__quad-cell--narrow">
                          <p className="scm-po-doc-preview__label">Currency:</p>
                          <p>INR</p>
                        </td>
                        <td className="scm-po-doc-preview__quad-cell scm-po-doc-preview__quad-cell--narrow">
                          <p className="scm-po-doc-preview__label">Payment Terms:</p>
                          <p>{paymentLabel}</p>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="scm-po-doc-preview__block-gap" aria-hidden />

          <div className="scm-po-doc-preview__products-wrap">
          <table className="scm-po-doc-preview__table scm-po-doc-preview__table--products">
            <colgroup>
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--sn" />
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--part" />
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--desc" />
              {showHsnCode ? (
                <col className="scm-po-doc-preview__col scm-po-doc-preview__col--hsn" />
              ) : null}
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--qty" />
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--unit" />
              <col className="scm-po-doc-preview__col scm-po-doc-preview__col--total" />
            </colgroup>
            <thead>
              <tr>
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod scm-po-doc-preview__th--idx">
                  S. NO
                </th>
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod">
                  Product Part No.
                </th>
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod scm-po-doc-preview__th--wide">
                  Description
                </th>
                {showHsnCode ? (
                  <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod">
                    HSN Code
                  </th>
                ) : null}
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod">
                  Total Qty.
                </th>
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod">
                  Unit Price INR
                </th>
                <th className="scm-po-doc-preview__th scm-po-doc-preview__th--prod">
                  Total INR
                </th>
              </tr>
            </thead>
            <tbody>
              {lineRows}
              <tr>
                <td
                  colSpan={showHsnCode ? 5 : 4}
                  className="scm-po-doc-preview__td scm-po-doc-preview__td--summary-spacer"
                />
                <td className="scm-po-doc-preview__td scm-po-doc-preview__summary-label scm-po-doc-preview__td--cen">
                  Total INR
                </td>
                <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num scm-po-doc-preview__td--summary-val">
                  <span className="scm-po-doc-preview__cell-num">
                    {formatInrScm(subtotalInr)}
                  </span>
                </td>
              </tr>
              {distributionChargesInr > 0 ? (
                <tr>
                  <td
                    colSpan={showHsnCode ? 5 : 4}
                    className="scm-po-doc-preview__td scm-po-doc-preview__td--summary-spacer"
                  />
                  <td className="scm-po-doc-preview__td scm-po-doc-preview__summary-label scm-po-doc-preview__td--cen">
                    Distribution charges (INR)
                  </td>
                  <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num scm-po-doc-preview__td--summary-val">
                    <span className="scm-po-doc-preview__cell-num">
                      {formatInrScm(distributionChargesInr)}
                    </span>
                  </td>
                </tr>
              ) : null}
              {taxSummaryRows}
              <tr>
                <td
                  colSpan={showHsnCode ? 5 : 4}
                  className="scm-po-doc-preview__td scm-po-doc-preview__td--summary-spacer"
                />
                <td className="scm-po-doc-preview__td scm-po-doc-preview__summary-label scm-po-doc-preview__td--cen">
                  Total Value of PO (INR)
                </td>
                <td className="scm-po-doc-preview__td scm-po-doc-preview__td--num scm-po-doc-preview__td--summary-grand">
                  <span className="scm-po-doc-preview__cell-num scm-po-doc-preview__cell-num--rs">
                    {formatInrScm(poGrand)}
                  </span>
                </td>
              </tr>
              <tr>
                <td
                  colSpan={showHsnCode ? 7 : 6}
                  className="scm-po-doc-preview__td scm-po-doc-preview__td--amount-words"
                >
                  <span className="scm-po-doc-preview__amount-words-k">Amount in Words.</span>{' '}
                  {formatInrAmountWords(poGrand)}
                </td>
              </tr>
            </tbody>
          </table>
          </div>

          <div className="scm-po-doc-preview__signature" aria-label="Signature block">
            <p className="scm-po-doc-preview__signature-for">
              For {companyHeader.name}
            </p>
            <p className="scm-po-doc-preview__signature-role">Authorized Signatory</p>
          </div>

        </article>

        <article className="scm-po-doc-preview__sheet" aria-label="Purchase order page 2">
          <h4 className="scm-po-doc-preview__terms-title">TERMS AND CONDITIONS</h4>
          <div className="scm-po-doc-preview__terms">
            {termSegments.map((seg, si) =>
              seg.kind === 'gap' ? (
                <div key={`g-${si}`} className="scm-po-doc-preview__term-gap" />
              ) : (
                <div key={`b-${si}`} className="scm-po-doc-preview__term-block">
                  {seg.lines.map((line, li) => {
                    const hang =
                      isNumberedBlockWithContinuations(seg.lines) && li > 0
                    return (
                      <p
                        key={li}
                        className={
                          hang
                            ? 'scm-po-doc-preview__term-line scm-po-doc-preview__term-line--hang'
                            : 'scm-po-doc-preview__term-line'
                        }
                      >
                        {line.trim() || '\u00a0'}
                      </p>
                    )
                  })}
                </div>
              ),
            )}
          </div>
          <p className="scm-po-doc-preview__terms-footer">{SCM_PO_ELECTRONIC_NOTICE}</p>
        </article>
          </div>
        </div>
      </div>
    </div>
  )
}
