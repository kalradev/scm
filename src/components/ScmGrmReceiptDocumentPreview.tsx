import type { ScmPoLine } from '../types/scmPo'
import { SCM_PO_LETTERHEAD } from '../lib/scmPoLetterhead'

function assetUrl(name: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}${name}`
}

function parseMoney(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function formatQty(raw: string): string {
  const t = String(raw ?? '').trim()
  if (!t) return '0'
  const n = parseMoney(t)
  if (!Number.isFinite(n)) return t
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

function lineLabel(line: ScmPoLine): string {
  const p = (line.partNumber || '').trim()
  const d = (line.itemDetails || '').trim()
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const head = p || d || 'Line'
  const rest = p && d && norm(p) !== norm(d) ? d : ''
  const combined = rest ? `${head} — ${rest}` : head
  return combined.length > 120 ? `${combined.slice(0, 118)}…` : combined
}

export function ScmGrmReceiptDocumentPreview(props: {
  grmRef: string
  poRef: string
  createdAtIso: string
  rows: Array<{
    line: ScmPoLine
    receivedQty: string
  }>
}) {
  const dt = new Date(props.createdAtIso)
  const dateLabel = Number.isNaN(dt.getTime())
    ? props.createdAtIso
    : dt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="scm-grm-receipt">
      <article className="scm-po-doc-preview__sheet" aria-label="GRN invoice">
        <table className="scm-grm-receipt__table scm-grm-receipt__table--header">
          <colgroup>
            <col className="scm-grm-receipt__col scm-grm-receipt__col--logo" />
            <col className="scm-grm-receipt__col scm-grm-receipt__col--center" />
            <col className="scm-grm-receipt__col scm-grm-receipt__col--address" />
          </colgroup>
          <tbody>
            <tr>
              <td className="scm-grm-receipt__logo">
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
              </td>
              <td className="scm-grm-receipt__title--center">
                <div className="scm-grm-receipt__h">GRN Invoice</div>
              </td>
              <td className="scm-grm-receipt__company-right">
                <p className="scm-grm-receipt__company-name">{SCM_PO_LETTERHEAD.legalName}</p>
                {SCM_PO_LETTERHEAD.registeredAddressLines.map((line, i) => (
                  <p key={i} className="scm-grm-receipt__company-line">
                    {line}
                  </p>
                ))}
                <p className="scm-grm-receipt__company-line">{SCM_PO_LETTERHEAD.phone}</p>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="scm-grm-receipt__lines">
          <thead>
            <tr>
              <th scope="col" className="scm-grm-receipt__th--narrow">
                #
              </th>
              <th scope="col">Item</th>
              <th scope="col" className="scm-grm-receipt__th--num">
                Received Qty
              </th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r, idx) => (
              <tr key={r.line.id}>
                <td>{idx + 1}</td>
                <td>{lineLabel(r.line)}</td>
                <td className="scm-grm-receipt__td--num">{formatQty(r.receivedQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="scm-grm-receipt__footer-meta">
          <p className="scm-grm-receipt__footer-line">GRN: {props.grmRef}</p>
          <p className="scm-grm-receipt__footer-line">
            <span>PO: {props.poRef}</span>
            <span className="scm-grm-receipt__footer-date">Date: {dateLabel}</span>
          </p>
        </div>
      </article>
    </div>
  )
}

