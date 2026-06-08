import { createContext } from 'react'
import type { AuthUser } from '../types/auth'

export type AuthStatus = 'loading' | 'ready'

export type AuthContextValue = {
  mode: 'local' | 'azure'
  status: AuthStatus
  user: AuthUser | null
  lastError: string | null
  /** Bearer token for `/api/*` (local JWT or Azure access token). */
  getAccessToken: () => Promise<string | null>
  /** Microsoft sign-in (only in `azure` mode). */
  login: (() => Promise<void>) | null
  /** Local: username and password against the API (only in `local` mode). */
  loginWithCredentials: ((username: string, password: string) => Promise<void>) | null
  /** Local: create the first admin account when no users exist yet. */
  registerFirstAdmin:
    | ((input: {
        username: string
        password: string
        displayName: string
        email: string
      }) => Promise<void>)
    | null
  logout: () => Promise<void>
  /**
   * Azure: Microsoft account picker to sign in as someone else.
   * Local: sign out and return to login.
   */
  switchAccount: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
