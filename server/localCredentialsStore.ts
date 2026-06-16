import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoredRole } from './rolesStore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, 'data', 'local-users.json')

export type LocalUserRecord = {
  id: string
  /** Normalized lowercase */
  username: string
  passwordHash: string
  salt: string
  role: StoredRole
  displayName: string
  email: string
  createdAt: string
}

type FileShape = { users: LocalUserRecord[] }

async function ensureFile(): Promise<void> {
  try {
    await readFile(DATA_PATH, 'utf8')
  } catch {
    const initial: FileShape = { users: [] }
    await writeFile(DATA_PATH, JSON.stringify(initial, null, 2), 'utf8')
  }
}

async function readAll(): Promise<FileShape> {
  await ensureFile()
  const raw = await readFile(DATA_PATH, 'utf8')
  try {
    const parsed = JSON.parse(raw) as FileShape
    if (!Array.isArray(parsed.users)) return { users: [] }
    return parsed
  } catch {
    return { users: [] }
  }
}

async function writeAll(data: FileShape): Promise<void> {
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2), 'utf8')
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64)
}

export function verifyPassword(record: LocalUserRecord, password: string): boolean {
  try {
    const salt = Buffer.from(record.salt, 'base64')
    const expected = Buffer.from(record.passwordHash, 'base64')
    const actual = hashPassword(password, salt)
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export async function countUsers(): Promise<number> {
  const { users } = await readAll()
  return users.length
}

export async function listLocalUserRecords(): Promise<LocalUserRecord[]> {
  const { users } = await readAll()
  return [...users].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

export async function getLocalUserById(id: string): Promise<LocalUserRecord | null> {
  const { users } = await readAll()
  return users.find((u) => u.id === id) ?? null
}

export async function getLocalUserByUsername(
  username: string,
): Promise<LocalUserRecord | null> {
  const key = normalizeUsername(username)
  const { users } = await readAll()
  return users.find((u) => u.username === key) ?? null
}

export async function getLocalUserByRole(
  role: StoredRole,
): Promise<LocalUserRecord | null> {
  const { users } = await readAll()
  return users.find((u) => u.role === role) ?? null
}

/** Ensures a local user exists for each role (dev / demo switching without passwords). */
export async function ensureDevUserForRole(role: StoredRole): Promise<LocalUserRecord> {
  const existing = await getLocalUserByRole(role)
  if (existing) return existing
  const label =
    role === 'scm'
      ? 'SCM'
      : role.charAt(0).toUpperCase() + role.slice(1)
  return createLocalUser({
    username: role,
    password: 'dev',
    role,
    displayName: `${label} (demo)`,
    email: '',
  })
}

export async function createLocalUser(input: {
  username: string
  password: string
  role: StoredRole
  displayName: string
  email: string
}): Promise<LocalUserRecord> {
  const username = normalizeUsername(input.username)
  if (username.length < 2 || username.length > 64) {
    throw new Error('invalid_username')
  }
  const data = await readAll()
  if (data.users.some((u) => u.username === username)) {
    throw new Error('username_taken')
  }
  const salt = randomBytes(16)
  const hashBuf = hashPassword(input.password, salt)
  const row: LocalUserRecord = {
    id: randomUUID(),
    username,
    salt: salt.toString('base64'),
    passwordHash: hashBuf.toString('base64'),
    role: input.role,
    displayName: input.displayName.trim() || username,
    email: input.email.trim(),
    createdAt: new Date().toISOString(),
  }
  data.users.push(row)
  await writeAll(data)
  return row
}

export async function deleteLocalUser(id: string): Promise<boolean> {
  const data = await readAll()
  const idx = data.users.findIndex((u) => u.id === id)
  if (idx === -1) return false
  data.users.splice(idx, 1)
  await writeAll(data)
  return true
}

export async function countAdmins(): Promise<number> {
  const { users } = await readAll()
  return users.filter((u) => u.role === 'admin').length
}

/** Optional .env seed when the store is empty (first server start). */
export async function maybeSeedAdminFromEnv(): Promise<void> {
  const u = process.env.LOCAL_SEED_ADMIN_USERNAME?.trim()
  const p = process.env.LOCAL_SEED_ADMIN_PASSWORD ?? ''
  if (!u || !p.trim()) return
  if ((await countUsers()) > 0) return
  await createLocalUser({
    username: u,
    password: p,
    role: 'admin',
    displayName: process.env.LOCAL_SEED_ADMIN_DISPLAY_NAME?.trim() || 'Administrator',
    email: process.env.LOCAL_SEED_ADMIN_EMAIL?.trim() || '',
  })
  console.log('[local-auth] Seeded admin user from LOCAL_SEED_ADMIN_* env vars.')
}
