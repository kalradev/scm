import pg from 'pg'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let pool: pg.Pool | null = null
let initPromise: Promise<boolean> | null = null

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
}

export function getPool(): pg.Pool | null {
  return pool
}

export async function initDatabase(): Promise<boolean> {
  if (!databaseConfigured()) return false
  if (initPromise) return initPromise

  initPromise = (async () => {
    const connectionString = process.env.DATABASE_URL!.trim()
    pool = new pg.Pool({ connectionString })
    await pool.query('SELECT 1')
    const schemaSql = await readFile(path.join(__dirname, 'schema.sql'), 'utf8')
    await pool.query(schemaSql)
    console.log('[db] PostgreSQL connected and schema ready')
    return true
  })().catch((err) => {
    console.error('[db] PostgreSQL init failed:', err)
    pool = null
    initPromise = null
    return false
  })

  return initPromise
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
  initPromise = null
}
