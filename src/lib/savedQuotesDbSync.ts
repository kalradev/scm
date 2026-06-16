import {
  fetchWorkflowQuotesFromServer,
  fetchWorkflowQuotesStatus,
  syncWorkflowQuotesToServer,
} from '../api/workflowQuotesApi'
import {
  readLocalStorageBackup,
  setQuotesStorageFromServer,
  clearQuotesStorageCache,
  type SavedQuoteRecord,
} from './savedQuotesStorage'

export type QuotesStorageBackend = 'database' | 'local'

let hydratePromise: Promise<QuotesStorageBackend> | null = null
let activeAuthToken: string | null = null

async function doHydrate(token: string): Promise<QuotesStorageBackend> {
  activeAuthToken = token
  try {
    const status = await fetchWorkflowQuotesStatus()
    if (!status.enabled) {
      clearQuotesStorageCache()
      return 'local'
    }

    let records = await fetchWorkflowQuotesFromServer(token)

    if (records.length === 0) {
      const legacy = readLocalStorageBackup()
      if (legacy.length > 0) {
        await syncWorkflowQuotesToServer(token, legacy)
        records = legacy
        console.info(
          `[scm] Imported ${legacy.length} quote(s) from browser storage into PostgreSQL`,
        )
      }
    }

    setQuotesStorageFromServer(records)
    return 'database'
  } catch (err) {
    console.warn('[scm] PostgreSQL quote storage unavailable; using localStorage', err)
    clearQuotesStorageCache()
    return 'local'
  }
}

/**
 * Load quotes from PostgreSQL on sign-in. If the database is empty but browser
 * localStorage still has rows (e.g. after port change), import them once.
 */
export async function hydrateSavedQuotesFromDatabase(
  token: string | null | undefined,
): Promise<QuotesStorageBackend> {
  if (!token) {
    clearQuotesStorageCache()
    return 'local'
  }
  if (hydratePromise) return hydratePromise

  hydratePromise = doHydrate(token).finally(() => {
    hydratePromise = null
  })
  return hydratePromise
}

export function resetQuotesHydration(): void {
  hydratePromise = null
  activeAuthToken = null
  clearQuotesStorageCache()
}

export function persistQuotesSnapshot(records: SavedQuoteRecord[]): void {
  const token = activeAuthToken
  if (!token) return
  void (async () => {
    try {
      await syncWorkflowQuotesToServer(token, records)
    } catch (err) {
      console.error('[scm] Failed to persist quotes to PostgreSQL', err)
    }
  })()
}
