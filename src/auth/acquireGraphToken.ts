import { getMsalInstance, loginRequest } from './msalConfig'

/** Returns a Graph access token if MSAL is configured and the user is signed in. */
export async function tryAcquireGraphAccessToken(): Promise<string | null> {
  const pca = getMsalInstance()
  if (!pca) return null
  try {
    await pca.initialize()
    const accounts = pca.getAllAccounts()
    if (accounts.length === 0) return null
    const silent = await pca.acquireTokenSilent({
      ...loginRequest,
      account: accounts[0],
    })
    return silent.accessToken
  } catch {
    return null
  }
}
