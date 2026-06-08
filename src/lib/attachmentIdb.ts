import type { OvfProofAttachment } from '../types/ovf'

const DB_NAME = 'scm_workflow_attachments_v1'
const STORE = 'attachments'

type StoredAttachmentRow = {
  id: string
  base64: string
  mimeType?: string
  fileName?: string
  savedAt: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb_unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb_open_failed'))
  })
}

export function isIdbBase64Ref(raw: string | undefined): boolean {
  const s = String(raw ?? '').trim()
  return s.startsWith('idb:')
}

export function makeIdbBase64Ref(id: string): string {
  return `idb:${id}`
}

export async function putAttachmentBase64(
  id: string,
  base64: string,
  meta?: { mimeType?: string; fileName?: string },
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const row: StoredAttachmentRow = {
      id,
      base64,
      mimeType: meta?.mimeType,
      fileName: meta?.fileName,
      savedAt: new Date().toISOString(),
    }
    store.put(row)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb_put_failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb_put_aborted'))
  })
  db.close()
}

export async function getAttachmentBase64(id: string): Promise<string | null> {
  const db = await openDb()
  const res = await new Promise<StoredAttachmentRow | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const req = store.get(id)
    req.onsuccess = () => resolve(req.result as StoredAttachmentRow | undefined)
    req.onerror = () => reject(req.error ?? new Error('indexeddb_get_failed'))
  })
  db.close()
  return res?.base64?.trim() ? res.base64.trim() : null
}

export async function resolveAttachmentBase64(
  payload: string,
): Promise<string> {
  const s = String(payload ?? '').trim()
  if (!s.startsWith('idb:')) return s
  const id = s.slice('idb:'.length).trim()
  if (!id) return ''
  const b64 = await getAttachmentBase64(id)
  return b64 ?? ''
}

/**
 * Reduce localStorage size by offloading large attachments to IndexedDB.
 * Keeps the type shape intact by replacing `dataBase64` with `idb:<id>`.
 */
export async function maybeOffloadAttachmentToIdb(
  att: OvfProofAttachment,
  opts?: { thresholdChars?: number },
): Promise<OvfProofAttachment> {
  const threshold = Math.max(50_000, opts?.thresholdChars ?? 250_000)
  const b64 = String(att.dataBase64 ?? '').trim()
  if (!b64) return att
  if (isIdbBase64Ref(b64)) return att
  if (b64.length < threshold) return att
  try {
    await putAttachmentBase64(att.id, b64, {
      mimeType: att.mimeType,
      fileName: att.fileName,
    })
    return { ...att, dataBase64: makeIdbBase64Ref(att.id) }
  } catch {
    // If IDB fails, keep inline base64 so the workflow still works.
    return att
  }
}

