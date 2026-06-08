import { buildQuoteTwoPagePdf } from './quotePdfTemplate'
import { buildQuoteExcelBlob } from './quoteExport'
import type { QuoteFormData } from '../types/quotePdf'

const GRAPH_SEND_MAIL = 'https://graph.microsoft.com/v1.0/me/sendMail'

export type ShareQuoteAttachmentMode = 'pdf' | 'excel' | 'both'

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const i = dataUrl.indexOf(',')
      resolve(i >= 0 ? dataUrl.slice(i + 1) : dataUrl)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

type GraphFileAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment'
  name: string
  contentType: string
  contentBytes: string
}

function parseGraphErrorBody(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } }
    return j.error?.message ?? null
  } catch {
    return null
  }
}

/**
 * Sends quote PDF and/or Excel via Microsoft Graph (appears in the user’s Outlook Sent Items).
 * Requires Entra app permission: Mail.Send (delegated), admin consent if required by tenant.
 */
export async function sendQuoteViaOutlook(params: {
  accessToken: string
  to: string
  subject: string
  bodyHtml: string
  mode: ShareQuoteAttachmentMode
  formSnapshot: QuoteFormData & { customerTitle?: string }
}): Promise<void> {
  const { accessToken, to, subject, bodyHtml, mode, formSnapshot } = params
  const address = to.trim()
  if (!address) throw new Error('Recipient email is required.')

  const attachments: GraphFileAttachment[] = []

  if (mode === 'pdf' || mode === 'both') {
    const pdfBlob = await buildQuoteTwoPagePdf(formSnapshot)
    const safe =
      String(formSnapshot.quoteRef ?? '')
        .replace(/[^\w.-]+/g, '_')
        .trim() || 'quote'
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: `${safe}.pdf`,
      contentType: 'application/pdf',
      contentBytes: await blobToBase64(pdfBlob),
    })
  }

  if (mode === 'excel' || mode === 'both') {
    const { blob, filename } = buildQuoteExcelBlob(formSnapshot)
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: filename,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBytes: await blobToBase64(blob),
    })
  }

  if (attachments.length === 0) {
    throw new Error('Choose PDF, Excel, or both.')
  }

  const res = await fetch(GRAPH_SEND_MAIL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: bodyHtml },
        toRecipients: [{ emailAddress: { address } }],
        attachments,
      },
      saveToSentItems: true,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    const msg =
      parseGraphErrorBody(text) ||
      (text ? text.slice(0, 280) : `Send failed (${res.status})`)
    throw new Error(msg)
  }
}
