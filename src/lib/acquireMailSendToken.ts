import { getMsalInstance, mailSendRequest } from '../auth/msalConfig'

/**
 * Acquires a token with Mail.Send (incremental consent via popup if needed).
 * Returns null when Microsoft sign-in is not configured or no account is present.
 */
export async function acquireMailSendToken(): Promise<string | null> {
  const pca = getMsalInstance()
  if (!pca) return null
  await pca.initialize()
  const accounts = pca.getAllAccounts()
  if (accounts.length === 0) return null
  const account = accounts[0]
  try {
    const silent = await pca.acquireTokenSilent({
      ...mailSendRequest,
      account,
    })
    return silent.accessToken
  } catch {
    const popup = await pca.acquireTokenPopup({
      ...mailSendRequest,
      account,
    })
    return popup.accessToken
  }
}
