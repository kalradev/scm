import type { QuoteFormData, QuoteLineForm } from '../types/quotePdf'
import { normalizeQuoteFormData } from '../lib/quoteFormDefaults'
import { filterCommercialLines } from '../lib/quoteLineItems'
import {
  buildTermSegments,
  getQuoteMoneySummary,
  isNumberedBlockWithContinuations,
  lineAmount,
  recipientBlockLines,
} from '../lib/quotePdfTemplate'
import { getSenderPdfContent } from '../lib/senderAddresses'

function parseQty(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function assetUrl(name: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}${name}`
}

type Props = {
  data: QuoteFormData
}

export function QuoteHtmlPreview({ data: raw }: Props) {
  const data = normalizeQuoteFormData(
    raw as QuoteFormData & { customerTitle?: string },
  )
  const sender = getSenderPdfContent(
    data.senderAddressPreset,
    data.quoteDate,
    data.quoteRef,
    data.validUntil,
  )
  const { total } = getQuoteMoneySummary(data)
  const commercialLines = filterCommercialLines(data.lineItems)
  const recipientLines = recipientBlockLines(
    data.customerName,
    data.customerCompanyName,
    data.customerAddress,
  )
  const termLines = (data.termsAndConditions || '').trim()
    ? data.termsAndConditions.split(/\r?\n/)
    : ['—']
  const termSegments = buildTermSegments(termLines)
  const introParas = (data.quoteIntro || '').trim()
    ? data.quoteIntro.split(/\n\s*\n/)
    : ['—']
  const closingParas = (data.quoteClosing || '').trim()
    ? data.quoteClosing.split(/\n\s*\n/)
    : ['—']

  return (
    <div className="quote-html-preview">
      <div className="quote-html-preview__scroll">
        <article className="quote-html-preview__sheet" aria-label="Quote page 1">
          <div className="quote-html-preview__band">
            <div className="quote-html-preview__logos">
              <img
                className="quote-html-preview__logo quote-html-preview__logo--cache"
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
              <img
                className="quote-html-preview__logo quote-html-preview__logo--wo"
                src={assetUrl('women-owned-logo.png')}
                alt=""
              />
            </div>
          </div>
          <div className="quote-html-preview__sender-block">
            {sender.headerLines.map((line, i) => (
              <div
                key={i}
                className={
                  line.blue
                    ? 'quote-html-preview__sender-line quote-html-preview__sender-line--blue'
                    : 'quote-html-preview__sender-line'
                }
                style={{ fontWeight: line.bold === false ? 400 : 700 }}
              >
                {line.text}
              </div>
            ))}
          </div>
          <div className="quote-html-preview__recipient">
            {recipientLines.map((ln, i) => (
              <div key={i}>{ln}</div>
            ))}
          </div>
          <div className="quote-html-preview__letter">
            <p className="quote-html-preview__sub">
              <strong>Sub: </strong>
              {data.subject.trim() || '—'}
            </p>
            <p>{data.quoteSalutation.trim() || 'Dear Sir,'}</p>
            <div className="quote-html-preview__intro">
              {introParas.map((para, i) => (
                <p key={i}>
                  {(para || '').replace(/\s+/g, ' ').trim() || '—'}
                </p>
              ))}
            </div>
          </div>
          <div className="quote-html-preview__table-wrap">
            <table className="quote-html-preview__table">
              <thead>
                <tr>
                  <th>S.No.</th>
                  <th>Product</th>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit Price (INR)</th>
                  <th>Total Price (INR)</th>
                </tr>
              </thead>
              <tbody>
                {commercialLines.map((line: QuoteLineForm, idx: number) => {
                  const amt = lineAmount(line)
                  return (
                    <tr key={line.id}>
                      <td>{idx + 1}</td>
                      <td>{(line.product || '').trim() || '—'}</td>
                      <td>{(line.description || '').trim() || '—'}</td>
                      <td>{String(parseQty(line.qty))}</td>
                      <td className="quote-html-preview__num">
                        {formatMoney(parseMoney(line.unitPrice))}
                      </td>
                      <td className="quote-html-preview__num">
                        {formatMoney(amt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="quote-html-preview__gt-label">
                    Grand Total
                  </td>
                  <td className="quote-html-preview__num quote-html-preview__gt">
                    {formatMoney(total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="quote-html-preview__closing">
            {closingParas.map((para, i) => (
              <p key={i}>
                {(para || '').replace(/\s+/g, ' ').trim() || '—'}
              </p>
            ))}
          </div>
        </article>

        <article className="quote-html-preview__sheet" aria-label="Quote page 2">
          <div className="quote-html-preview__band">
            <div className="quote-html-preview__logos">
              <img
                className="quote-html-preview__logo quote-html-preview__logo--cache"
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
              <img
                className="quote-html-preview__logo quote-html-preview__logo--wo"
                src={assetUrl('women-owned-logo.png')}
                alt=""
              />
            </div>
          </div>
          <h4 className="quote-html-preview__terms-title">TERMS AND CONDITIONS:</h4>
          <div className="quote-html-preview__terms">
            {termSegments.map((seg, si) =>
              seg.kind === 'gap' ? (
                <div key={`g-${si}`} className="quote-html-preview__term-gap" />
              ) : (
                <div key={`b-${si}`} className="quote-html-preview__term-block">
                  {seg.lines.map((line, li) => {
                    const hang =
                      isNumberedBlockWithContinuations(seg.lines) && li > 0
                    return (
                      <p
                        key={li}
                        className={
                          hang
                            ? 'quote-html-preview__term-line quote-html-preview__term-line--hang'
                            : 'quote-html-preview__term-line'
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
          <p className="quote-html-preview__thanks">Thank you,</p>
          {data.signatoryName.trim() ? (
            <p className="quote-html-preview__signatory">{data.signatoryName.trim()}</p>
          ) : null}
          <footer className="quote-html-preview__footer">
            <div>{sender.footerCompany}</div>
            <div>{sender.footerRegisteredLine}</div>
            <div>{sender.footerContactLine}</div>
          </footer>
        </article>
      </div>
    </div>
  )
}
