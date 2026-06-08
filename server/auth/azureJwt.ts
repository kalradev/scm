import * as jose from 'jose'

let jwks: jose.JWTVerifyGetKey | null = null

function getJwks(tenantId: string): jose.JWTVerifyGetKey {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      ),
    )
  }
  return jwks
}

/** Default: Microsoft Graph access token audiences. */
const DEFAULT_AUDIENCES = [
  'https://graph.microsoft.com',
  '00000003-0000-0000-c000-000000000000',
]

export type AzureTokenPayload = {
  oid?: string
  name?: string
  preferred_username?: string
  email?: string
  upn?: string
}

export async function verifyAzureAccessToken(
  token: string,
): Promise<AzureTokenPayload> {
  const tenantId = process.env.AZURE_TENANT_ID?.trim()
  if (!tenantId) {
    throw new Error('AZURE_TENANT_ID is not set')
  }

  const audEnv = process.env.AZURE_EXPECTED_AUDIENCES?.trim()
  const audiences = audEnv
    ? audEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_AUDIENCES

  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`

  const { payload } = await jose.jwtVerify(token, getJwks(tenantId), {
    issuer,
    audience: audiences,
    clockTolerance: 60,
  })

  return payload as AzureTokenPayload
}

export function claimsFromPayload(
  payload: AzureTokenPayload,
): { oid: string; displayName: string; email: string } | null {
  const oid = String(payload.oid ?? '').trim()
  if (!oid) return null
  const displayName = String(payload.name ?? '').trim() || oid
  const email =
    String(
      payload.preferred_username ??
        payload.email ??
        payload.upn ??
        '',
    ).trim() || oid
  return { oid, displayName, email }
}
