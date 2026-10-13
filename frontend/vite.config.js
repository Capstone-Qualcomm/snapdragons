import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/slack": "http://127.0.0.1:3002",
      "/auth/slack": "http://127.0.0.1:3002",
      "/api": "http://127.0.0.1:3001",
      "/auth": "http://127.0.0.1:3001",
    },
  },
})