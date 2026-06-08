import type { AuthUser } from '../types/auth'
import type { Role } from '../types/roles'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/** Session token for local username/password auth (sessionStorage). */
export const LOCAL_SESSION_TOKEN_KEY = 'scm-workflow-local-jwt'

export type LocalUserPublic = {
  id: string
  username: string
  displayName: string
  email: string
  role: Role
  createdAt: string
}

async function jsonError(res: Response): Promise<string> {
  try {
    const j = await res.json()
    return j && typeof j === 'object' && j && 'error' in j
      ? String((j as { error: string }).error)
      : 'request_failed'
  } catch {
    return 'request_failed'
  }
}

export async function fetchLocalAuthStatus(): Promise<{ hasUsers: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/local/status`)
  if (!res.ok) throw new Error('local_status_failed')
  return res.json() as Promise<{ hasUsers: boolean }>
}

export async function localRegisterFirstAdmin(input: {
  username: string
  password: string
  displayName: string
  email: string
}): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API_BASE}/api/auth/local/register-first`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await jsonError(res))
  }
  return res.json() as Promise<{ token: string; user: AuthUser }>
}

export async function localLogin(
  username: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API_BASE}/api/auth/local/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    throw new Error(await jsonError(res))
  }
  return res.json() as Promise<{ token: string; user: AuthUser }>
}

export async function fetchLocalMe(accessToken: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/auth/local/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'error' in err
        ? String((err as { error: string }).error)
        : 'me_failed',
    )
  }
  return res.json() as Promise<AuthUser>
}

export async function adminListLocalUsers(
  accessToken: string,
): Promise<{ users: LocalUserPublic[] }> {
  const res = await fetch(`${API_BASE}/api/admin/local-users`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('list_local_users_failed')
  return res.json() as Promise<{ users: LocalUserPublic[] }>
}

export async function adminCreateLocalUser(
  accessToken: string,
  body: {
    username: string
    password: string
    role: Role
    displayName: string
    email: string
  },
): Promise<{ user: LocalUserPublic }> {
  const res = await fetch(`${API_BASE}/api/admin/local-users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(await jsonError(res))
  }
  return res.json() as Promise<{ user: LocalUserPublic }>
}

export async function adminDeleteLocalUser(
  accessToken: string,
  id: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/admin/local-users/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!res.ok) {
    throw new Error(await jsonError(res))
  }
}

export async function fetchMe(accessToken: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'error' in err
        ? String((err as { error: string }).error)
        : 'me_failed',
    )
  }
  return res.json() as Promise<AuthUser>
}

export async function fetchAssignments(accessToken: string) {
  const res = await fetch(`${API_BASE}/api/admin/assignments`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('assignments_failed')
  return res.json() as Promise<{ assignments: Record<string, string> }>
}

export async function putAssignment(
  accessToken: string,
  oid: string,
  role: string | null,
) {
  const res = await fetch(
    `${API_BASE}/api/admin/assignments/${encodeURIComponent(oid)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role }),
    },
  )
  if (!res.ok) throw new Error('put_assignment_failed')
  return res.json()
}
