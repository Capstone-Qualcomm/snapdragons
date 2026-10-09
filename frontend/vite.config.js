import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Slack only redirects to HTTPS, so local Slack testing goes through a Cloudflare tunnel.
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/auth": "http://127.0.0.1:3001",
    },
  },
})
