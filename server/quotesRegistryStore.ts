import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, 'data', 'quotes-registry.json')

export type RegisteredQuoteRow = {
  /** Same id as client SavedQuoteRecord.id */
  id: string
  quoteRef: string
  savedAt: string
  savedByOid: string
  savedByEmail: string
  savedByDisplayName: string
  customerName: string
  subject: string
}

async function ensureFile(): Promise<void> {
  try {
    await readFile(DATA_PATH, 'utf8')
  } catch {
    await writeFile(DATA_PATH, '[]', 'utf8')
  }
}

export async function listQuotesNewestFirst(): Promise<RegisteredQuoteRow[]> {
  await ensureFile()
  const raw = await readFile(DATA_PATH, 'utf8')
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const rows = parsed as RegisteredQuoteRow[]
    return rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  } catch {
    return []
  }
}

export async function upsertQuote(row: RegisteredQuoteRow): Promise<void> {
  await ensureFile()
  const all = await listQuotesNewestFirst()
  const i = all.findIndex((r) => r.id === row.id)
  if (i === -1) {
    all.unshift(row)
  } else {
    all[i] = row
  }
  await writeFile(DATA_PATH, JSON.stringify(all, null, 2), 'utf8')
}
