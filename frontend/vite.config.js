import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: "/snapdragons/",
  plugins: [react()],
  server: {
    proxy: {
      "/api/cluster": "http://127.0.0.1:3003",
      "/api/slack": "http://127.0.0.1:3002",
      "/auth/slack": "http://127.0.0.1:3002",
      "/api": "http://127.0.0.1:3001",
      "/auth": "http://127.0.0.1:3001",
    },
  },
})