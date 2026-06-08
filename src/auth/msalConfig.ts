import {
  type Configuration,
  LogLevel,
  PublicClientApplication,
} from '@azure/msal-browser'

export const loginRequest = {
  scopes: ['User.Read'],
}

/** Delegated permission: send mail as the signed-in user (Microsoft Graph). */
export const mailSendRequest = {
  scopes: ['Mail.Send'],
}

/** True when both Entra app ID and tenant are set (Microsoft sign-in available). */
export function isAzureAuthConfigured(): boolean {
  const clientId = import.meta.env.VITE_AZURE_CLIENT_ID?.trim()
  const tenantId = import.meta.env.VITE_AZURE_TENANT_ID?.trim()
  return Boolean(clientId && tenantId)
}

export function getMsalInstance(): PublicClientApplication | null {
  if (!isAzureAuthConfigured()) {
    return null
  }
  const clientId = import.meta.env.VITE_AZURE_CLIENT_ID!.trim()
  const tenantId = import.meta.env.VITE_AZURE_TENANT_ID!.trim()

  const config: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: 'sessionStorage',
      storeAuthStateInCookie: false,
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Error,
      },
    },
  }

  return new PublicClientApplication(config)
}
