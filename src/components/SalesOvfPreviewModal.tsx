import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { OvfEntryPage } from '../pages/OvfEntryPage'
import { SalesOvfPreviewShellContext } from './SalesOvfPreviewShellContext'

type Props = {
  quoteId: string
  onClose: () => void
}

export function SalesOvfPreviewModal({ quoteId, onClose }: Props) {
  const [htmlDownload, setHtmlDownload] = useState<(() => void) | null>(null)
  const shell = useMemo(
    () => ({
      /**
       * Store a click handler as state. Must not pass the handler straight into
       * `setState` — React would treat a function value as an updater and run it
       * immediately (triggering download on modal open).
       */
      setHtmlDownloadHandler: (fn: (() => void) | null) => {
        if (fn === null) {
          setHtmlDownload(null)
        } else {
          setHtmlDownload(() => fn)
        }
      },
    }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="quote-preview-modal__backdrop quote-preview-modal__backdrop--ovf"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="quote-preview-modal quote-preview-modal--ovf"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sales-ovf-preview-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="quote-preview-modal__header">
          <h2 id="sales-ovf-preview-title" className="quote-preview-modal__title">
            OVF (read-only)
          </h2>
          <div className="quote-preview-modal__header-actions">
            {htmlDownload ? (
              <button
                type="button"
                className="btn btn-ghost ovf-entry__download-icon-btn quote-preview-modal__header-download"
                title="Download OVF (HTML)"
                aria-label="Download OVF (HTML)"
                onClick={() => htmlDownload()}
              >
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
              </button>
            ) : null}
            <button
              type="button"
              className="share-quote-modal__close"
              aria-label="Close"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        <SalesOvfPreviewShellContext.Provider value={shell}>
          <div className="quote-preview-modal__body quote-preview-modal__body--ovf">
            <OvfEntryPage mode="sales" embeddedInModal modalQuoteId={quoteId} />
          </div>
        </SalesOvfPreviewShellContext.Provider>
      </div>
    </div>,
    document.body,
  )
}
