/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AZURE_CLIENT_ID?: string
  readonly VITE_AZURE_TENANT_ID?: string
  /** Override API origin (default: same origin, use Vite proxy in dev). */
  readonly VITE_API_BASE_URL?: string
  /** Same value as server SCM_INTERNAL_SECRET — registers/lists quotes without Azure JWT (local dev). */
  readonly VITE_SCM_INTERNAL_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
