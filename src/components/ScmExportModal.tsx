import { useEffect, useState } from 'react'
import type { ScmExportOptions } from '../lib/scmPoExport'
import { exportScmPoWorkbookToFile } from '../lib/scmPoExport'

type Props = {
  open: boolean
  defaultPreparedBy: string
  onClose: () => void
}

export function ScmExportModal({ open, defaultPreparedBy, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [preparedBy, setPreparedBy] = useState(defaultPreparedBy)
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPreparedBy(defaultPreparedBy)
      setErr(null)
    }
  }, [open, defaultPreparedBy])

  if (!open) return null

  const onDownload = async () => {
    setErr(null)
    setExporting(true)
    try {
      const opts: ScmExportOptions = {
        reportTitle: title.trim() || undefined,
        notes: notes.trim() || undefined,
        preparedBy: preparedBy.trim() || undefined,
      }
      await exportScmPoWorkbookToFile(opts)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!exporting) onClose()
      }}
    >
      <div
        className="modal-card modal-card--scm-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scm-export-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="scm-export-modal-title" className="modal-card__title">
          Excel export
        </h3>

        {err ? <p className="modal-card__error">{err}</p> : null}

        <label className="modal-card__field scm-home__export-field">
          <span className="scm-po__label">Report title</span>
          <input
            type="text"
            className="field__control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional"
            disabled={exporting}
            maxLength={200}
          />
        </label>
        <label className="modal-card__field scm-home__export-field">
          <span className="scm-po__label">Prepared by</span>
          <input
            type="text"
            className="field__control"
            value={preparedBy}
            onChange={(e) => setPreparedBy(e.target.value)}
            placeholder="Your name"
            disabled={exporting}
            maxLength={120}
          />
        </label>
        <label className="modal-card__field scm-home__export-field">
          <span className="scm-po__label">Notes</span>
          <textarea
            className="field__control scm-home__export-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Optional"
            disabled={exporting}
            maxLength={4000}
          />
        </label>

        <div className="modal-card__actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={exporting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onDownload()}
            disabled={exporting}
          >
            {exporting ? 'Building…' : 'Download Excel'}
          </button>
        </div>
      </div>
    </div>
  )
}
