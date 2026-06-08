import * as jose from 'jose'
import type { StoredRole } from './rolesStore'

const ROLES: StoredRole[] = ['sales', 'finance', 'scm', 'admin']

function getSecretKey(): Uint8Array {
  const s = process.env.LOCAL_JWT_SECRET?.trim()
  if (!s) {
    console.warn(
      '[local-auth] LOCAL_JWT_SECRET is unset; using a dev-only default. Set LOCAL_JWT_SECRET in production.',
    )
    return new TextEncoder().encode('scm-local-dev-jwt-secret-change-me')
  }
  return new TextEncoder().encode(s)
}

export async function signLocalSession(
  userId: string,
  role: StoredRole,
): Promise<string> {
  return new jose.SignJWT({ role, typ: 'local' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('14d')
    .sign(getSecretKey())
}

export async function verifyLocalSession(
  token: string,
): Promise<{ sub: string; role: StoredRole } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getSecretKey(), {
      algorithms: ['HS256'],
    })
    if (payload.typ !== 'local' || typeof payload.sub !== 'string') return null
    const role = payload.role
    if (typeof role !== 'string' || !ROLES.includes(role as StoredRole))
      return null
    return { sub: payload.sub, role: role as StoredRole }
  } catch {
    return null
  }
}
