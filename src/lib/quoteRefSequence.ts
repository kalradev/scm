import { getMaxFinalQuoteSequenceForYear } from './savedQuotesStorage'

/**
 * Per-user quote reference sequence: QT-{year}-{nnn…} (e.g. QT-2026-001).
 * Stored in localStorage (`scm_workflow_quote_seq_by_user_v1`) so each signed-in
 * account has its own counter and reconciled max from that user's finalized
 * quotes only (other accounts on the same browser no longer inflate “your” next number).
 * Resets when the calendar year changes. Not synced across devices without a backend.
 */
const SEQ_BY_USER_KEY = 'scm_workflow_quote_seq_by_user_v2'

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
    /* quota / private mode */
  }
}

/**
 * Next sequence number from the persisted counter and finalized refs for this user.
 * Drops an "orphan" counter (stored ≫ highest quote) so dev/testing does not
 * skip ahead when no finals exist yet. Still bumps when the counter is only
 * one ahead of max finalized (in-flight before save completes).
 */
function computeNextSequence(
  year: number,
  savedBy: string,
  rawStoredLastUsed: number,
): number {
  const maxFromFinal = getMaxFinalQuoteSequenceForYear(year, savedBy)
  const reconciled = Math.min(rawStoredLastUsed, maxFromFinal)
  const base = Math.max(maxFromFinal + 1, reconciled + 1)
  const inFlightCeiling = maxFromFinal + 1
  if (rawStoredLastUsed <= inFlightCeiling) {
    return Math.max(base, rawStoredLastUsed + 1)
  }
  return base
}

function refFromSeq(year: number, seq: number): string {
  return `QT-${year}-${String(seq).padStart(3, '0')}`
}

/**
 * Returns the next quote ref that **would** be issued, without consuming the
 * sequence (for confirmations). Matches {@link allocateNextQuoteRef} logic.
 */
export function peekNextQuoteRef(savedBy: string): string {
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

/**
 * Assigns and returns the next quote ref for the current calendar year for this user.
 */
export function allocateNextQuoteRef(savedBy: string): string {
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
      /* quota / private mode — use memory fallback */
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
