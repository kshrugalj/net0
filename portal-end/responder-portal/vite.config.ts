import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Proxy /api to IPv4 loopback. `fastapi dev` binds 127.0.0.1; "localhost" is often ::1.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_PROXY || 'http://127.0.0.1:8000'
  const proxy = {
    '/api': { target, changeOrigin: true },
  }
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})
