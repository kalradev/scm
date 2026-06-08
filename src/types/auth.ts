import type { Role } from './roles'

/** Mirrors GET /api/me */
export type AuthUser = {
  displayName: string
  email: string
  oid: string
  role: Role | null
  isAdmin: boolean
}
