import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, 'data', 'role-assignments.json')

export type StoredRole = 'sales' | 'finance' | 'scm' | 'admin'

export type RoleAssignmentsFile = {
  /** Azure AD `oid` → app role */
  assignments: Record<string, StoredRole>
}

async function ensureFile(): Promise<void> {
  try {
    await readFile(DATA_PATH, 'utf8')
  } catch {
    const initial: RoleAssignmentsFile = { assignments: {} }
    await writeFile(DATA_PATH, JSON.stringify(initial, null, 2), 'utf8')
  }
}

export async function readAssignments(): Promise<RoleAssignmentsFile> {
  await ensureFile()
  const raw = await readFile(DATA_PATH, 'utf8')
  try {
    const parsed = JSON.parse(raw) as RoleAssignmentsFile
    if (!parsed.assignments || typeof parsed.assignments !== 'object') {
      return { assignments: {} }
    }
    return parsed
  } catch {
    return { assignments: {} }
  }
}

export async function writeAssignments(
  data: RoleAssignmentsFile,
): Promise<void> {
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2), 'utf8')
}

export async function getRoleForOid(
  oid: string,
): Promise<StoredRole | null> {
  const { assignments } = await readAssignments()
  const r = assignments[oid]
  return r ?? null
}

export async function setRoleForOid(
  oid: string,
  role: StoredRole | null,
): Promise<void> {
  const data = await readAssignments()
  if (role === null) {
    delete data.assignments[oid]
  } else {
    data.assignments[oid] = role
  }
  await writeAssignments(data)
}
