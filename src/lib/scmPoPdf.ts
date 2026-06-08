import { downloadBlob } from './quoteExport'

function safeFileName(raw: string): string {
  return String(raw || 'po').replace(/[^\w.-]+/g, '_')
}

async function awaitImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  if (imgs.length === 0) return
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) return resolve()
          const done = () => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        }),
    ),
  )
}

/**
 * Export only the rendered PO "sheet" nodes to avoid extra blank pages caused by
 * exporting the scroll container.
 */
export async function buildScmPoPdfBlobFromRenderedPreview(
  previewRoot: HTMLElement,
): Promise<Blob> {
  const sheetEls = Array.from(
    previewRoot.querySelectorAll('.scm-po-doc-preview__sheet'),
  ) as HTMLElement[]

  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as unknown as {
    addPage: () => void
    addImage: (
      dataUrl: string,
      format: 'PNG',
      x: number,
      y: number,
      w: number,
      h: number,
    ) => void
    internal: { pageSize: { getWidth: () => number; getHeight: () => number } }
    output: (type: 'blob') => Blob
  }

  // Use html2canvas directly so each "sheet" becomes exactly one PDF page.
  const html2canvasMod = await import('html2canvas')
  const html2canvas = (html2canvasMod as any).default as (
    el: HTMLElement,
    opts: any,
  ) => Promise<HTMLCanvasElement>

  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 4
  const targetW = pageW - margin * 2
  const targetH = pageH - margin * 2

  const sheets = sheetEls.length ? sheetEls : [previewRoot]
  for (let i = 0; i < sheets.length; i++) {
    const el = sheets[i]!
    // Remove card chrome for export (closer to the preview/PDF look).
    el.classList.add('scm-po-doc-preview__sheet--export')
    await awaitImages(el)

    const scaler = el.parentElement
    const fitWrap =
      scaler?.parentElement?.classList.contains('scm-po-doc-preview__fit')
        ? (scaler.parentElement as HTMLElement)
        : null
    const isScaled =
      scaler?.classList.contains('scm-po-doc-preview__scale-inner') ?? false
    let prevScalerTransform = ''
    let prevFitWidth = ''
    let prevFitHeight = ''
    if (isScaled && scaler instanceof HTMLElement) {
      prevScalerTransform = scaler.style.transform
      scaler.style.transform = 'none'
    }
    if (fitWrap) {
      prevFitWidth = fitWrap.style.width
      prevFitHeight = fitWrap.style.height
      fitWrap.style.width = ''
      fitWrap.style.height = ''
    }

    let canvas: HTMLCanvasElement | undefined
    try {
      canvas = await html2canvas(el, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        windowWidth: 860,
      })
    } finally {
      if (isScaled && scaler instanceof HTMLElement) {
        scaler.style.transform = prevScalerTransform
      }
      if (fitWrap) {
        fitWrap.style.width = prevFitWidth
        fitWrap.style.height = prevFitHeight
      }
    }
    if (!canvas) {
      throw new Error('Unable to capture PO preview for PDF.')
    }
    const img = canvas.toDataURL('image/png')

    const imgWpx = canvas.width
    const imgHpx = canvas.height
    // Prefer filling width; shrink only if height would overflow.
    let scale = targetW / imgWpx
    if (imgHpx * scale > targetH) scale = targetH / imgHpx
    const w = imgWpx * scale
    const h = imgHpx * scale
    const x = margin
    const y = margin

    if (i > 0) doc.addPage()
    doc.addImage(img, 'PNG', x, y, w, h)
    el.classList.remove('scm-po-doc-preview__sheet--export')
  }

  return doc.output('blob')
}

export async function downloadScmPoPdfFromRenderedPreview(opts: {
  previewRoot: HTMLElement
  filenameBase: string
}): Promise<void> {
  const blob = await buildScmPoPdfBlobFromRenderedPreview(opts.previewRoot)
  downloadBlob(blob, `${safeFileName(opts.filenameBase)}.pdf`)
}

