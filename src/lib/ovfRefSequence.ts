import { getMaxFinalOvfSequenceForYear } from './savedQuotesStorage'

const SEQ_BY_USER_KEY = 'scm_workflow_ovf_seq_by_user_v2'

type UserSeq = { year: number; lastUsed: number }
type SeqMap = Record<string, UserSeq>

let memoryByUser = new Map<string, UserSeq>()

function readUserSeq(oid: string): UserSeq | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(SEQ_BY_USER_KEY)
    if (!raw) return null
    const m = JSON.parse(raw) as SeqMap
    const u = m[oid]
    if (
      u &&
      typeof u.year === 'number' &&
      typeof u.lastUsed === 'number'
    ) {
      return u
    }
  } catch {
    /* ignore */
  }
  return null
}

function writeUserSeq(oid: string, data: UserSeq): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    let m: SeqMap = {}
    const raw = window.localStorage.getItem(SEQ_BY_USER_KEY)
    if (raw) {
      try {
        m = JSON.parse(raw) as SeqMap
        if (!m || typeof m !== 'object') m = {}
      } catch {
        m = {}
      }
    }
    m[oid] = data
    window.localStorage.setItem(SEQ_BY_USER_KEY, JSON.stringify(m))
  } catch {
    /* quota */
  }
}

function computeNextSequence(
  year: number,
  savedBy: string,
  rawStoredLastUsed: number,
): number {
  const maxFromFinal = getMaxFinalOvfSequenceForYear(year, savedBy)
  const reconciled = Math.min(rawStoredLastUsed, maxFromFinal)
  const base = Math.max(maxFromFinal + 1, reconciled + 1)
  const inFlightCeiling = maxFromFinal + 1
  if (rawStoredLastUsed <= inFlightCeiling) {
    return Math.max(base, rawStoredLastUsed + 1)
  }
  return base
}

function refFromSeq(year: number, seq: number): string {
  return `OVF-${year}-${String(seq).padStart(3, '0')}`
}

export function peekNextOvfRef(savedBy: string): string {
  const year = new Date().getFullYear()

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = readUserSeq(savedBy)
      let storedLastUsed = 0
      if (stored && stored.year === year) {
        storedLastUsed = stored.lastUsed
      }
      const next = computeNextSequence(year, savedBy, storedLastUsed)
      return refFromSeq(year, next)
    } catch {
      /* fall through */
    }
  }

  let mem = memoryByUser.get(savedBy)
  if (!mem || mem.year !== year) {
    mem = { year, lastUsed: 0 }
    memoryByUser.set(savedBy, mem)
  }
  const next = computeNextSequence(year, savedBy, mem.lastUsed)
  return refFromSeq(year, next)
}

export function allocateNextOvfRef(savedBy: string): string {
  const year = new Date().getFullYear()

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = readUserSeq(savedBy)
      let storedLastUsed = 0
      if (stored && stored.year === year) {
        storedLastUsed = stored.lastUsed
      }
      const next = computeNextSequence(year, savedBy, storedLastUsed)
      writeUserSeq(savedBy, { year, lastUsed: next })
      let mem = memoryByUser.get(savedBy)
      if (!mem || mem.year !== year) {
        mem = { year, lastUsed: 0 }
      }
      mem.lastUsed = next
      memoryByUser.set(savedBy, mem)
      return refFromSeq(year, next)
    } catch {
      /* memory fallback */
    }
  }

  let mem = memoryByUser.get(savedBy)
  if (!mem || mem.year !== year) {
    mem = { year, lastUsed: 0 }
    memoryByUser.set(savedBy, mem)
  }
  const next = computeNextSequence(year, savedBy, mem.lastUsed)
  mem.lastUsed = next
  memoryByUser.set(savedBy, mem)
  return refFromSeq(year, next)
}
