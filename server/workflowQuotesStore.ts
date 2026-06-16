import type { Pool } from 'pg'
import { getPool } from './db/pool'

/** Same shape as client SavedQuoteRecord (stored as JSONB). */
export type WorkflowQuoteRow = {
  id: string
  savedAt: string
  savedBy: string
  savedByDisplayName?: string
  quoteRef: string
  formSnapshot: unknown
  kind?: 'draft' | 'final'
  po?: unknown
  ovf?: unknown
  scmPo?: unknown
  scmGrm?: unknown
  quoteFinanceReview?: unknown
  customerQuoteShipment?: unknown
  poFinanceReview?: unknown
}

function requirePool(): Pool {
  const pool = getPool()
  if (!pool) throw new Error('database_unavailable')
  return pool
}

export async function listAllWorkflowQuotes(): Promise<WorkflowQuoteRow[]> {
  const pool = requirePool()
  const result = await pool.query<{ data: WorkflowQuoteRow }>(
    `SELECT data FROM workflow_quotes
     ORDER BY (data->>'savedAt') DESC NULLS LAST`,
  )
  return result.rows.map((r) => r.data)
}

export async function getWorkflowQuoteById(
  id: string,
): Promise<WorkflowQuoteRow | null> {
  const pool = requirePool()
  const result = await pool.query<{ data: WorkflowQuoteRow }>(
    `SELECT data FROM workflow_quotes WHERE id = $1`,
    [id],
  )
  return result.rows[0]?.data ?? null
}

export async function upsertWorkflowQuote(
  record: WorkflowQuoteRow,
): Promise<void> {
  const pool = requirePool()
  await pool.query(
    `INSERT INTO workflow_quotes (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = NOW()`,
    [record.id, JSON.stringify(record)],
  )
}

export async function deleteWorkflowQuote(id: string): Promise<boolean> {
  const pool = requirePool()
  const result = await pool.query(
    `DELETE FROM workflow_quotes WHERE id = $1`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

/** Full sync: upsert all incoming rows and delete rows removed on the client. */
export async function syncWorkflowQuotes(
  records: WorkflowQuoteRow[],
): Promise<void> {
  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM workflow_quotes`,
    )
    const incomingIds = new Set(records.map((r) => r.id))
    for (const row of existing.rows) {
      if (!incomingIds.has(row.id)) {
        await client.query(`DELETE FROM workflow_quotes WHERE id = $1`, [
          row.id,
        ])
      }
    }
    for (const record of records) {
      await client.query(
        `INSERT INTO workflow_quotes (id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data, updated_at = NOW()`,
        [record.id, JSON.stringify(record)],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
