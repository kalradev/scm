type Props = {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}

export function FinanceSubmitModal({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: Props) {
  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-queue-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="finance-queue-modal-title" className="modal-card__title">
          {title}
        </h3>
        {description ? <p className="muted modal-card__desc">{description}</p> : null}
        <div className="modal-card__actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
