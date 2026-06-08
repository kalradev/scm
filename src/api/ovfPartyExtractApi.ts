import type { CustomerPartyHints, VendorPartyHints } from '../lib/extractOvfPartyDetails'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

export async function fetchCustomerPartyExtractOpenAI(
  accessToken: string,
  text: string,
): Promise<
  | { ok: true; hints: CustomerPartyHints }
  | { ok: false; error: string; status: number }
> {
  const res = await fetch(`${API_BASE}/api/ovf/extract-customer-party`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })
  if (res.status === 503) {
    return { ok: false, error: 'openai_unconfigured', status: 503 }
  }
  if (!res.ok) {
    let error = 'request_failed'
    try {
      const j = await res.json()
      if (j && typeof j === 'object' && 'error' in j) {
        error = String((j as { error: string }).error)
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error, status: res.status }
  }
  const data = (await res.json()) as { hints?: CustomerPartyHints }
  return { ok: true, hints: data.hints ?? {} }
}

export async function fetchVendorPartyExtractOpenAI(
  accessToken: string,
  text: string,
): Promise<
  | { ok: true; hints: VendorPartyHints }
  | { ok: false; error: string; status: number }
> {
  const res = await fetch(`${API_BASE}/api/ovf/extract-vendor-party`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })
  if (res.status === 503) {
    return { ok: false, error: 'openai_unconfigured', status: 503 }
  }
  if (!res.ok) {
    let error = 'request_failed'
    try {
      const j = await res.json()
      if (j && typeof j === 'object' && 'error' in j) {
        error = String((j as { error: string }).error)
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error, status: res.status }
  }
  const data = (await res.json()) as { hints?: VendorPartyHints }
  return { ok: true, hints: data.hints ?? {} }
}
