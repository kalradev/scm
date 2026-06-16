import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT || '3002'

  return {
    plugins: [react()],
    /** Ensures MSAL is pre-bundled when deps are present (avoids resolve errors after lockfile changes). */
    optimizeDeps: {
      include: ['@azure/msal-browser', '@azure/msal-react', 'pdfjs-dist'],
    },
    server: {
      port: 5174,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  }
})
