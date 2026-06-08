import { useCallback, useEffect, useId, useState } from 'react'
import { acquireMailSendToken } from '../lib/acquireMailSendToken'
import {
  sendQuoteViaOutlook,
  type ShareQuoteAttachmentMode,
} from '../lib/sendQuoteOutlook'
import { isAzureAuthConfigured } from '../auth/msalConfig'
import type { QuoteFormData } from '../types/quotePdf'
import type { SavedQuoteRecord } from '../lib/savedQuotesStorage'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Props = {
  record: SavedQuoteRecord
  onClose: () => void
}

export function ShareQuoteOutlookModal({ record, onClose }: Props) {
  const titleId = useId()
  const [mode, setMode] = useState<ShareQuoteAttachmentMode>('both')
  const [to, setTo] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const azureOk = isAzureAuthConfigured()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSend = useCallback(async () => {
    setError(null)
    if (!azureOk) {
      setError(
        'Outlook send requires Microsoft sign-in. Set VITE_AZURE_CLIENT_ID and VITE_AZURE_TENANT_ID.',
      )
      return
    }
    const addr = to.trim()
    if (!EMAIL_RE.test(addr)) {
      setError('Enter a valid recipient email address.')
      return
    }
    setSending(true)
    try {
      const token = await acquireMailSendToken()
      if (!token) {
        setError('Could not get permission to send mail. Sign in with Microsoft.')
        return
      }
      const ref = String(record.quoteRef || '').trim() || 'Quote'
      const subject = `Quote ${ref}`
      const bodyHtml =
        '<p>Please find the quote attached.</p><p>Thank you.</p>'
      await sendQuoteViaOutlook({
        accessToken: token,
        to: addr,
        subject,
        bodyHtml,
        mode,
        formSnapshot: record.formSnapshot as QuoteFormData & {
          customerTitle?: string
        },
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed.')
    } finally {
      setSending(false)
    }
  }, [azureOk, mode, onClose, record.formSnapshot, record.quoteRef, to])

  return (
    <div
      className="share-quote-modal__backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="share-quote-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="share-quote-modal__header">
          <h3 id={titleId} className="share-quote-modal__title">
            Share via Outlook
          </h3>
          <button
            type="button"
            className="share-quote-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="share-quote-modal__ref muted">
          {record.quoteRef}
          {record.formSnapshot.customerName?.trim()
            ? ` · ${record.formSnapshot.customerName.trim()}`
            : ''}
        </p>
        <fieldset className="share-quote-modal__formats">
          <legend className="share-quote-modal__legend">Attachments</legend>
          <label className="share-quote-modal__radio">
            <input
              type="radio"
              name="shareFormat"
              checked={mode === 'pdf'}
              onChange={() => setMode('pdf')}
            />
            PDF only
          </label>
          <label className="share-quote-modal__radio">
            <input
              type="radio"
              name="shareFormat"
              checked={mode === 'excel'}
              onChange={() => setMode('excel')}
            />
            Excel only
          </label>
          <label className="share-quote-modal__radio">
            <input
              type="radio"
              name="shareFormat"
              checked={mode === 'both'}
              onChange={() => setMode('both')}
            />
            PDF and Excel
          </label>
        </fieldset>
        <label className="share-quote-modal__field">
          <span>To (email)</span>
          <input
            type="email"
            autoComplete="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="customer@company.com"
            disabled={sending}
          />
        </label>
        {!azureOk ? (
          <p className="share-quote-modal__warn">Microsoft sign-in required to send.</p>
        ) : null}
        {error ? <p className="share-quote-modal__error">{error}</p> : null}
        <div className="share-quote-modal__actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={sending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSend()}
            disabled={sending || !azureOk}
          >
            {sending ? 'Sending…' : 'Send with Outlook'}
          </button>
        </div>
      </div>
    </div>
  )
}
