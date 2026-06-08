import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  /** Ensures MSAL is pre-bundled when deps are present (avoids resolve errors after lockfile changes). */
  optimizeDeps: {
    include: ['@azure/msal-browser', '@azure/msal-react', 'pdfjs-dist'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
