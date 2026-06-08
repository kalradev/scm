import { createContext, useContext } from 'react'

export type SalesOvfPreviewShellApi = {
  /** Register HTML download (or clear when null). Used only inside Sales OVF preview modal. */
  setHtmlDownloadHandler: (fn: (() => void) | null) => void
}

export const SalesOvfPreviewShellContext = createContext<SalesOvfPreviewShellApi | null>(null)

export function useSalesOvfPreviewShell(): SalesOvfPreviewShellApi | null {
  return useContext(SalesOvfPreviewShellContext)
}
