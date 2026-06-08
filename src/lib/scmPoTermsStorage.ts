const STORAGE_KEY = 'scm_workflow_scm_po_terms_v2'

export type ScmPoGlobalTerms = {
  /** If true, new POs default to these fixed terms. */
  fixed: boolean
  terms: string
  items?: ScmPoGlobalTermsItem[]
  updatedAt: string
}

export type ScmPoGlobalTermsItem = {
  id: string
  text: string
  /** If true, included by default for new POs (and when "use global" is enabled). */
  pinned: boolean
}

function normalizeBlock(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function normalizeOneLine(s: string | undefined | null): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** Split saved PO / global terms text into editable line items (blank lines separate points). */
export function parseTermsStringToItems(raw: string): ScmPoGlobalTermsItem[] {
  return splitTermsToItems(raw)
}

function splitTermsToItems(raw: string): ScmPoGlobalTermsItem[] {
  const text = normalizeBlock(raw)
  if (!text) return []
  const lines = text.split('\n')
  const blocks: string[] = []
  let buf: string[] = []
  const flush = () => {
    const joined = buf.join('\n').trim()
    if (joined) blocks.push(joined)
    buf = []
  }
  for (const ln of lines) {
    if (!ln.trim()) {
      flush()
      continue
    }
    buf.push(ln)
  }
  flush()

  return blocks.map((b) => {
    const one = normalizeOneLine(b)
    const withoutLeadingNumber = one.replace(/^\d+\.\s*/, '').trim()
    return {
      id: `po-term-${crypto.randomUUID()}`,
      text: withoutLeadingNumber || one,
      pinned: true,
    }
  })
}

export function joinItemsToTerms(
  items: ScmPoGlobalTermsItem[],
  options?: { onlyPinned?: boolean },
): string {
  const onlyPinned = options?.onlyPinned === true
  const clean = items
    .map((x) => ({ ...x, text: normalizeOneLine(x.text) }))
    .filter((x) => x.text.length > 0)
    .filter((x) => (onlyPinned ? x.pinned : true))
  return clean
    .map((x, i) => `${i + 1}. ${x.text}`)
    .join('\n\n')
    .trim()
}

function defaultGlobalTerms(): ScmPoGlobalTerms {
  const base = defaultScmPoTermsAndConditions()
  const items = splitTermsToItems(base)
  return {
    fixed: false,
    terms: base,
    items,
    updatedAt: new Date().toISOString(),
  }
}

export function defaultScmPoTermsAndConditions(): string {
  return [
    '1. Purchaser, its group Companies and associates are committed to operating its businesses conforming to the highest moral and ethical standards. The Seller/Service Provider is required to be committed to acting professionally, fairly and with integrity in all its business dealings and relationships wherever it operates, and to implementing and enforcing effective systems to counter bribery and unethical practices. The Seller/Service Provider shall comply with all applicable anti-bribery and anti-corruption laws of India and international transactions under this Purchase Order.',
    '',
    '2. Both Purchaser and Seller/Service Provider shall comply with all applicable export control laws, trade sanctions, related regulations, and ensure that the goods and services procured under this Purchase Order are not in violation of such laws.',
    '',
    '3. Compliance with the Company’s Anti-Corruption and Anti-Bribery Policy and Export Control and Trade Compliance Policy, as amended from time to time available at https://www.cachedigitech.com/policies is mandatory.',
  ].join('\n')
}

export function readScmPoGlobalTerms(): ScmPoGlobalTerms {
  if (typeof window === 'undefined' || !window.localStorage) return defaultGlobalTerms()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultGlobalTerms()
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object') return defaultGlobalTerms()
    const fixed = Boolean((p as ScmPoGlobalTerms).fixed)
    const terms = normalizeBlock((p as ScmPoGlobalTerms).terms)
    const itemsRaw = (p as ScmPoGlobalTerms).items
    const items =
      Array.isArray(itemsRaw) && itemsRaw.length > 0
        ? itemsRaw
            .filter(
              (x): x is ScmPoGlobalTermsItem =>
                x &&
                typeof x === 'object' &&
                typeof (x as ScmPoGlobalTermsItem).id === 'string' &&
                typeof (x as ScmPoGlobalTermsItem).text === 'string' &&
                typeof (x as ScmPoGlobalTermsItem).pinned === 'boolean',
            )
            .map((x) => ({
              ...x,
              text: normalizeOneLine(x.text),
            }))
        : splitTermsToItems(terms || defaultGlobalTerms().terms)
    const updatedAt = String((p as ScmPoGlobalTerms).updatedAt ?? '').trim()
    const builtTerms = joinItemsToTerms(items.filter((x) => x.pinned))
    return {
      fixed,
      terms: builtTerms || terms || defaultGlobalTerms().terms,
      items,
      updatedAt: updatedAt || new Date().toISOString(),
    }
  } catch {
    return defaultGlobalTerms()
  }
}

export function writeScmPoGlobalTerms(next: {
  fixed: boolean
  terms?: string
  items?: ScmPoGlobalTermsItem[]
}): ScmPoGlobalTerms {
  const baseItems = Array.isArray(next.items)
    ? next.items
        .map((x) => ({
          id: String(x.id || `po-term-${crypto.randomUUID()}`),
          text: normalizeOneLine(x.text),
          pinned: Boolean(x.pinned),
        }))
        .filter((x) => x.text.length > 0)
    : splitTermsToItems(String(next.terms ?? ''))
  const pinnedItems = baseItems.filter((x) => x.pinned)
  const termsBuilt = joinItemsToTerms(pinnedItems)
  const row: ScmPoGlobalTerms = {
    fixed: Boolean(next.fixed),
    terms: termsBuilt || defaultGlobalTerms().terms,
    items: baseItems.length > 0 ? baseItems : defaultGlobalTerms().items,
    updatedAt: new Date().toISOString(),
  }
  if (typeof window === 'undefined' || !window.localStorage) return row
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(row))
  } catch {
    /* quota */
  }
  return row
}

