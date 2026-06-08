import { MsalProvider, useMsal } from '@azure/msal-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  fetchMe,
  fetchLocalMe,
  LOCAL_SESSION_TOKEN_KEY,
  localLogin,
  localRegisterFirstAdmin,
} from '../api/authApi'
import { getMsalInstance, loginRequest } from '../auth/msalConfig'
import type { AuthUser } from '../types/auth'
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
} from './authContextTypes'

function AuthProviderLocal({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const token = sessionStorage.getItem(LOCAL_SESSION_TOKEN_KEY)
      if (!token) {
        if (!cancelled) {
          setUser(null)
          setStatus('ready')
        }
        return
      }
      try {
        const me = await fetchLocalMe(token)
        if (!cancelled) setUser(me)
      } catch {
        sessionStorage.removeItem(LOCAL_SESSION_TOKEN_KEY)
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setStatus('ready')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const loginWithCredentials = useCallback(
    async (username: string, password: string) => {
      setLastError(null)
      const { token, user: next } = await localLogin(username, password)
      sessionStorage.setItem(LOCAL_SESSION_TOKEN_KEY, token)
      setUser(next)
    },
    [],
  )

  const registerFirstAdmin = useCallback(
    async (input: {
      username: string
      password: string
      displayName: string
      email: string
    }) => {
      setLastError(null)
      const { token, user: next } = await localRegisterFirstAdmin(input)
      sessionStorage.setItem(LOCAL_SESSION_TOKEN_KEY, token)
      setUser(next)
    },
    [],
  )

  const logout = useCallback(async () => {
    setUser(null)
    setLastError(null)
    sessionStorage.removeItem(LOCAL_SESSION_TOKEN_KEY)
  }, [])

  const switchAccount = useCallback(async () => {
    await logout()
    window.location.assign('/login')
  }, [logout])

  const getAccessToken = useCallback(async () => {
    return sessionStorage.getItem(LOCAL_SESSION_TOKEN_KEY)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'local',
      status,
      user,
      lastError,
      getAccessToken,
      login: null,
      loginWithCredentials,
      registerFirstAdmin,
      logout,
      switchAccount,
    }),
    [
      status,
      user,
      lastError,
      getAccessToken,
      loginWithCredentials,
      registerFirstAdmin,
      logout,
      switchAccount,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function AuthProviderAzure({ children }: { children: ReactNode }) {
  const { instance, accounts } = useMsal()
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [msalReady, setMsalReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    instance
      .initialize()
      .then(() => {
        return instance.handleRedirectPromise()
      })
      .finally(() => {
        if (!cancelled) setMsalReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [instance])

  useEffect(() => {
    if (!msalReady) return

    if (accounts.length === 0) {
      setUser(null)
      setLastError(null)
      setStatus('ready')
      return
    }

    const account = accounts[0]
    let cancelled = false

    async function load() {
      setStatus('loading')
      setLastError(null)
      try {
        let accessToken: string
        try {
          const silent = await instance.acquireTokenSilent({
            ...loginRequest,
            account,
          })
          accessToken = silent.accessToken
        } catch {
          const popup = await instance.acquireTokenPopup({
            ...loginRequest,
            account,
          })
          accessToken = popup.accessToken
        }
        if (cancelled) return
        const me = await fetchMe(accessToken)
        if (cancelled) return
        setUser(me)
      } catch (e) {
        if (!cancelled) {
          setUser(null)
          setLastError(e instanceof Error ? e.message : 'auth_failed')
        }
      } finally {
        if (!cancelled) setStatus('ready')
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [msalReady, accounts, instance])

  const login = useCallback(async () => {
    setLastError(null)
    await instance.loginPopup(loginRequest)
  }, [instance])

  const logout = useCallback(async () => {
    setUser(null)
    setLastError(null)
    await instance.logoutPopup({
      postLogoutRedirectUri: window.location.origin,
    })
  }, [instance])

  const switchAccount = useCallback(async () => {
    setLastError(null)
    await instance.loginPopup({
      ...loginRequest,
      prompt: 'select_account',
    })
  }, [instance])

  const getAccessToken = useCallback(async () => {
    const account = accounts[0]
    if (!account) return null
    try {
      const silent = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
      })
      return silent.accessToken
    } catch {
      try {
        const popup = await instance.acquireTokenPopup({
          ...loginRequest,
          account,
        })
        return popup.accessToken
      } catch {
        return null
      }
    }
  }, [instance, accounts])

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'azure',
      status,
      user,
      lastError,
      getAccessToken,
      login,
      loginWithCredentials: null,
      registerFirstAdmin: null,
      logout,
      switchAccount,
    }),
    [status, user, lastError, getAccessToken, login, logout, switchAccount],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const pca = getMsalInstance()
  if (!pca) {
    return <AuthProviderLocal>{children}</AuthProviderLocal>
  }
  return (
    <MsalProvider instance={pca}>
      <AuthProviderAzure>{children}</AuthProviderAzure>
    </MsalProvider>
  )
}
