import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import {
  claimsFromPayload,
  verifyAzureAccessToken,
} from './auth/azureJwt'
import type { StoredRole } from './rolesStore'
import {
  listQuotesNewestFirst,
  upsertQuote,
  type RegisteredQuoteRow,
} from './quotesRegistryStore'
import {
  getRoleForOid,
  readAssignments,
  setRoleForOid,
} from './rolesStore'
import {
  countAdmins,
  countUsers,
  createLocalUser,
  deleteLocalUser,
  ensureDevUserForRole,
  getLocalUserById,
  getLocalUserByUsername,
  listLocalUserRecords,
  maybeSeedAdminFromEnv,
  verifyPassword,
} from './localCredentialsStore'
import { signLocalSession, verifyLocalSession } from './localAuthJwt'
import {
  extractCustomerPartyWithOpenAI,
  extractVendorPartyWithOpenAI,
  openaiPartyExtractAvailable,
} from './openaiPartyExtract'
import { databaseConfigured, initDatabase } from './db/pool'
import {
  deleteWorkflowQuote,
  listAllWorkflowQuotes,
  syncWorkflowQuotes,
  type WorkflowQuoteRow,
} from './workflowQuotesStore'

const PORT = Number(process.env.PORT ?? 3002)

const ROLES: StoredRole[] = ['sales', 'finance', 'scm', 'admin']

function parseAdminOids(): Set<string> {
  const raw = process.env.ADMIN_OBJECT_IDS?.trim() ?? ''
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function isAdminOid(oid: string): boolean {
  return parseAdminOids().has(oid)
}

function canUseAdminApi(oid: string, assignedRole: StoredRole | null): boolean {
  return isAdminOid(oid) || assignedRole === 'admin'
}

async function getBearerToken(
  req: express.Request,
): Promise<string | null> {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return null
  const t = h.slice('Bearer '.length).trim()
  return t || null
}

/** Local JWT or Azure access token (same Bearer header as /api/me). */
async function resolveBearerAuth(
  req: express.Request,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const token = await getBearerToken(req)
  if (!token) return { ok: false, status: 401, error: 'missing_token' }
  const loc = await verifyLocalSession(token)
  if (loc) return { ok: true }
  try {
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims) return { ok: false, status: 401, error: 'invalid_token_claims' }
    return { ok: true }
  } catch {
    return { ok: false, status: 401, error: 'invalid_token' }
  }
}

/** Optional shared secret so local dev can register/list quotes without Azure JWT. */
function internalSecretOk(req: express.Request): boolean {
  const expected = process.env.SCM_INTERNAL_SECRET?.trim()
  if (!expected) return false
  const h = req.headers['x-scm-internal-secret']
  return typeof h === 'string' && h === expected
}

const app = express()
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', async (_req, res) => {
  const dbReady = databaseConfigured() && Boolean(await initDatabase())
  res.json({ ok: true, database: dbReady })
})

/* --- Local username/password auth (no Azure) --- */

type LocalUserPublic = {
  id: string
  username: string
  displayName: string
  email: string
  role: StoredRole
  createdAt: string
}

function toPublicLocalUser(
  r: import('./localCredentialsStore').LocalUserRecord,
): LocalUserPublic {
  return {
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    email: r.email,
    role: r.role,
    createdAt: r.createdAt,
  }
}

async function localSessionRecord(
  req: express.Request,
): Promise<
  | { ok: true; record: import('./localCredentialsStore').LocalUserRecord }
  | { ok: false; status: number; error: string }
> {
  const token = await getBearerToken(req)
  if (!token) return { ok: false, status: 401, error: 'missing_token' }
  const session = await verifyLocalSession(token)
  if (!session) return { ok: false, status: 401, error: 'invalid_token' }
  const record = await getLocalUserById(session.sub)
  if (!record) return { ok: false, status: 401, error: 'invalid_session' }
  return { ok: true, record }
}

app.get('/api/auth/local/status', async (_req, res) => {
  try {
    const n = await countUsers()
    res.json({ hasUsers: n > 0 })
  } catch (e) {
    console.error('[api/auth/local/status]', e)
    res.status(500).json({ error: 'status_failed' })
  }
})

app.post('/api/auth/local/register-first', async (req, res) => {
  try {
    if ((await countUsers()) > 0) {
      res.status(403).json({ error: 'already_initialized' })
      return
    }
    const body = req.body as {
      username?: string
      password?: string
      displayName?: string
      email?: string
    }
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username.trim() || password.length < 4) {
      res.status(400).json({ error: 'invalid_credentials' })
      return
    }
    const row = await createLocalUser({
      username,
      password,
      role: 'admin',
      displayName:
        typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim()
          : username.trim(),
      email: typeof body.email === 'string' ? body.email : '',
    })
    const token = await signLocalSession(row.id, row.role)
    res.json({
      token,
      user: {
        displayName: row.displayName,
        email: row.email || '—',
        oid: row.id,
        role: row.role,
        isAdmin: true,
      },
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'username_taken') {
      res.status(409).json({ error: 'username_taken' })
      return
    }
    console.error('[api/auth/local/register-first]', e)
    res.status(400).json({ error: 'register_failed' })
  }
})

app.post('/api/auth/local/login', async (req, res) => {
  try {
    const body = req.body as { username?: string; password?: string }
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const row = await getLocalUserByUsername(username)
    if (!row || !verifyPassword(row, password)) {
      res.status(401).json({ error: 'invalid_credentials' })
      return
    }
    const token = await signLocalSession(row.id, row.role)
    res.json({
      token,
      user: {
        displayName: row.displayName,
        email: row.email || '—',
        oid: row.id,
        role: row.role,
        isAdmin: row.role === 'admin',
      },
    })
  } catch (e) {
    console.error('[api/auth/local/login]', e)
    res.status(500).json({ error: 'login_failed' })
  }
})

/** Dev/demo: sign in as a role without a password (local auth only). */
app.post('/api/auth/local/dev-switch', async (req, res) => {
  try {
    const body = req.body as { role?: string }
    const role = body.role
    if (
      role !== 'sales' &&
      role !== 'finance' &&
      role !== 'scm' &&
      role !== 'admin'
    ) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    const row = await ensureDevUserForRole(role)
    const token = await signLocalSession(row.id, row.role)
    res.json({
      token,
      user: {
        displayName: row.displayName,
        email: row.email || '—',
        oid: row.id,
        role: row.role,
        isAdmin: row.role === 'admin',
      },
    })
  } catch (e) {
    console.error('[api/auth/local/dev-switch]', e)
    res.status(500).json({ error: 'dev_switch_failed' })
  }
})

app.get('/api/auth/local/me', async (req, res) => {
  const s = await localSessionRecord(req)
  if (!s.ok) {
    res.status(s.status).json({ error: s.error })
    return
  }
  const row = s.record
  res.json({
    displayName: row.displayName,
    email: row.email || '—',
    oid: row.id,
    role: row.role,
    isAdmin: row.role === 'admin',
  })
})

app.get('/api/admin/local-users', async (req, res) => {
  const s = await localSessionRecord(req)
  if (!s.ok) {
    res.status(s.status).json({ error: s.error })
    return
  }
  if (s.record.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const rows = await listLocalUserRecords()
  res.json({ users: rows.map(toPublicLocalUser) })
})

app.post('/api/admin/local-users', async (req, res) => {
  const s = await localSessionRecord(req)
  if (!s.ok) {
    res.status(s.status).json({ error: s.error })
    return
  }
  if (s.record.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const body = req.body as {
    username?: string
    password?: string
    role?: string
    displayName?: string
    email?: string
  }
  const username = typeof body.username === 'string' ? body.username : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const roleRaw = body.role
  if (!username.trim() || password.length < 4) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (typeof roleRaw !== 'string' || !ROLES.includes(roleRaw as StoredRole)) {
    res.status(400).json({ error: 'invalid_role' })
    return
  }
  try {
    const row = await createLocalUser({
      username,
      password,
      role: roleRaw as StoredRole,
      displayName:
        typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim()
          : username.trim(),
      email: typeof body.email === 'string' ? body.email : '',
    })
    res.json({ user: toPublicLocalUser(row) })
  } catch (e) {
    if (e instanceof Error && e.message === 'username_taken') {
      res.status(409).json({ error: 'username_taken' })
      return
    }
    console.error('[api/admin/local-users POST]', e)
    res.status(400).json({ error: 'create_failed' })
  }
})

app.delete('/api/admin/local-users/:id', async (req, res) => {
  const s = await localSessionRecord(req)
  if (!s.ok) {
    res.status(s.status).json({ error: s.error })
    return
  }
  if (s.record.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const id = String(req.params.id ?? '').trim()
  if (!id) {
    res.status(400).json({ error: 'invalid_id' })
    return
  }
  if (id === s.record.id) {
    res.status(400).json({ error: 'cannot_delete_self' })
    return
  }
  const target = await getLocalUserById(id)
  if (!target) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (target.role === 'admin' && (await countAdmins()) <= 1) {
    res.status(400).json({ error: 'last_admin' })
    return
  }
  await deleteLocalUser(id)
  res.json({ ok: true })
})

app.get('/api/me', async (req, res) => {
  const token = await getBearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'missing_token' })
    return
  }
  try {
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims) {
      res.status(401).json({ error: 'invalid_token_claims' })
      return
    }
    const role = await getRoleForOid(claims.oid)
    const isAdmin = isAdminOid(claims.oid) || role === 'admin'
    res.json({
      displayName: claims.displayName,
      email: claims.email,
      oid: claims.oid,
      role,
      isAdmin,
    })
  } catch (e) {
    console.error('[api/me]', e)
    res.status(401).json({ error: 'invalid_token' })
  }
})

app.get('/api/admin/assignments', async (req, res) => {
  const token = await getBearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'missing_token' })
    return
  }
  try {
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims) {
      res.status(401).json({ error: 'invalid_token_claims' })
      return
    }
    const assignedRole = await getRoleForOid(claims.oid)
    if (!canUseAdminApi(claims.oid, assignedRole)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    const data = await readAssignments()
    res.json(data)
  } catch (e) {
    console.error('[api/admin/assignments GET]', e)
    res.status(401).json({ error: 'invalid_token' })
  }
})

app.put('/api/admin/assignments/:oid', async (req, res) => {
  const token = await getBearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'missing_token' })
    return
  }
  try {
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims) {
      res.status(401).json({ error: 'invalid_token_claims' })
      return
    }
    const assignedRole = await getRoleForOid(claims.oid)
    if (!canUseAdminApi(claims.oid, assignedRole)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    const oid = String(req.params.oid ?? '').trim()
    if (!/^[0-9a-f-]{36}$/i.test(oid)) {
      res.status(400).json({ error: 'invalid_oid' })
      return
    }
    const body = req.body as { role?: string | null }
    const roleRaw = body.role
    if (roleRaw === null || roleRaw === undefined) {
      await setRoleForOid(oid, null)
      res.json({ ok: true, oid, role: null })
      return
    }
    if (typeof roleRaw !== 'string' || !ROLES.includes(roleRaw as StoredRole)) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    await setRoleForOid(oid, roleRaw as StoredRole)
    res.json({ ok: true, oid, role: roleRaw })
  } catch (e) {
    console.error('[api/admin/assignments PUT]', e)
    res.status(401).json({ error: 'invalid_token' })
  }
})

app.post('/api/quotes/register', async (req, res) => {
  const body = req.body as Partial<RegisteredQuoteRow>
  if (
    typeof body.id !== 'string' ||
    typeof body.quoteRef !== 'string' ||
    typeof body.savedAt !== 'string' ||
    typeof body.savedByOid !== 'string' ||
    typeof body.savedByEmail !== 'string' ||
    typeof body.savedByDisplayName !== 'string' ||
    typeof body.customerName !== 'string' ||
    typeof body.subject !== 'string'
  ) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (!body.quoteRef.trim()) {
    res.status(400).json({ error: 'empty_quote_ref' })
    return
  }

  const row: RegisteredQuoteRow = {
    id: body.id,
    quoteRef: body.quoteRef.trim(),
    savedAt: body.savedAt,
    savedByOid: body.savedByOid.trim(),
    savedByEmail: body.savedByEmail.trim(),
    savedByDisplayName: body.savedByDisplayName.trim(),
    customerName: body.customerName.trim() || '—',
    subject: body.subject.trim() || '—',
  }

  try {
    if (internalSecretOk(req)) {
      await upsertQuote(row)
      res.json({ ok: true })
      return
    }

    const token = await getBearerToken(req)
    if (!token) {
      res.status(401).json({ error: 'missing_token' })
      return
    }
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims || claims.oid !== row.savedByOid) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    await upsertQuote(row)
    res.json({ ok: true })
  } catch (e) {
    console.error('[api/quotes/register]', e)
    res.status(401).json({ error: 'invalid_token' })
  }
})

app.post('/api/ovf/extract-customer-party', async (req, res) => {
  const auth = await resolveBearerAuth(req)
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error })
    return
  }
  if (!openaiPartyExtractAvailable()) {
    res.status(503).json({ error: 'openai_unconfigured' })
    return
  }
  const body = req.body as { text?: unknown }
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    res.status(400).json({ error: 'missing_text' })
    return
  }
  try {
    const hints = await extractCustomerPartyWithOpenAI(text)
    res.json({ hints })
  } catch (e) {
    console.error('[api/ovf/extract-customer-party]', e)
    res.status(502).json({ error: 'openai_failed' })
  }
})

app.post('/api/ovf/extract-vendor-party', async (req, res) => {
  const auth = await resolveBearerAuth(req)
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error })
    return
  }
  if (!openaiPartyExtractAvailable()) {
    res.status(503).json({ error: 'openai_unconfigured' })
    return
  }
  const body = req.body as { text?: unknown }
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    res.status(400).json({ error: 'missing_text' })
    return
  }
  try {
    const hints = await extractVendorPartyWithOpenAI(text)
    res.json({ hints })
  } catch (e) {
    console.error('[api/ovf/extract-vendor-party]', e)
    res.status(502).json({ error: 'openai_failed' })
  }
})

app.get('/api/admin/quotes', async (req, res) => {
  try {
    if (internalSecretOk(req)) {
      const quotes = await listQuotesNewestFirst()
      res.json({ quotes })
      return
    }

    const token = await getBearerToken(req)
    if (!token) {
      res.status(401).json({ error: 'missing_token' })
      return
    }
    const payload = await verifyAzureAccessToken(token)
    const claims = claimsFromPayload(payload)
    if (!claims) {
      res.status(401).json({ error: 'invalid_token_claims' })
      return
    }
    const assignedRole = await getRoleForOid(claims.oid)
    if (!canUseAdminApi(claims.oid, assignedRole)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    const quotes = await listQuotesNewestFirst()
    res.json({ quotes })
  } catch (e) {
    console.error('[api/admin/quotes GET]', e)
    res.status(401).json({ error: 'invalid_token' })
  }
})

/* --- Workflow quotes (PostgreSQL) — replaces browser localStorage --- */

function isWorkflowQuoteRow(value: unknown): value is WorkflowQuoteRow {
  if (!value || typeof value !== 'object') return false
  const r = value as WorkflowQuoteRow
  return (
    typeof r.id === 'string' &&
    typeof r.savedAt === 'string' &&
    typeof r.savedBy === 'string' &&
    typeof r.quoteRef === 'string' &&
    r.formSnapshot !== undefined &&
    r.formSnapshot !== null
  )
}

app.get('/api/workflow/quotes/status', async (_req, res) => {
  if (!databaseConfigured()) {
    res.json({ enabled: false })
    return
  }
  const ready = await initDatabase()
  res.json({ enabled: ready })
})

app.get('/api/workflow/quotes', async (req, res) => {
  const auth = await resolveBearerAuth(req)
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error })
    return
  }
  if (!databaseConfigured()) {
    res.status(503).json({ error: 'database_not_configured' })
    return
  }
  const ready = await initDatabase()
  if (!ready) {
    res.status(503).json({ error: 'database_unavailable' })
    return
  }
  try {
    const quotes = await listAllWorkflowQuotes()
    res.json({ quotes })
  } catch (e) {
    console.error('[api/workflow/quotes GET]', e)
    res.status(500).json({ error: 'list_failed' })
  }
})

app.post(
  '/api/workflow/quotes/sync',
  express.json({ limit: '100mb' }),
  async (req, res) => {
    const auth = await resolveBearerAuth(req)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }
    if (!databaseConfigured()) {
      res.status(503).json({ error: 'database_not_configured' })
      return
    }
    const ready = await initDatabase()
    if (!ready) {
      res.status(503).json({ error: 'database_unavailable' })
      return
    }
    const body = req.body as { quotes?: unknown }
    if (!Array.isArray(body.quotes)) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    const quotes = body.quotes.filter(isWorkflowQuoteRow)
    try {
      await syncWorkflowQuotes(quotes)
      res.json({ ok: true, count: quotes.length })
    } catch (e) {
      console.error('[api/workflow/quotes/sync POST]', e)
      res.status(500).json({ error: 'sync_failed' })
    }
  },
)

app.delete('/api/workflow/quotes/:id', async (req, res) => {
  const auth = await resolveBearerAuth(req)
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error })
    return
  }
  if (!databaseConfigured()) {
    res.status(503).json({ error: 'database_not_configured' })
    return
  }
  const ready = await initDatabase()
  if (!ready) {
    res.status(503).json({ error: 'database_unavailable' })
    return
  }
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'invalid_id' })
    return
  }
  try {
    const removed = await deleteWorkflowQuote(id)
    res.json({ ok: true, removed })
  } catch (e) {
    console.error('[api/workflow/quotes DELETE]', e)
    res.status(500).json({ error: 'delete_failed' })
  }
})

void maybeSeedAdminFromEnv()
  .catch((e) => {
    console.error('[local-auth] seed failed', e)
  })
  .finally(async () => {
    if (databaseConfigured()) {
      await initDatabase()
    }
    app.listen(PORT, () => {
      console.log(`[api] http://localhost:${PORT}`)
      if (databaseConfigured()) {
        console.log('[db] DATABASE_URL is set — quotes persist to PostgreSQL')
      } else {
        console.log('[db] DATABASE_URL not set — quotes stay in browser localStorage')
      }
    })
  })
