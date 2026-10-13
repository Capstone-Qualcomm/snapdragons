import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: "/snapdragons/",
  plugins: [react()],
  server: {
    proxy: {
      "/snapdragons/api/cluster": { target: "http://127.0.0.1:3003", rewrite: (path) => path.replace(/^\/snapdragons/, "") },
      "/snapdragons/api/slack": { target: "http://127.0.0.1:3002", rewrite: (path) => path.replace(/^\/snapdragons/, "") },
      "/snapdragons/auth/slack": { target: "http://127.0.0.1:3002", rewrite: (path) => path.replace(/^\/snapdragons/, "") },
      "/snapdragons/api": { target: "http://127.0.0.1:3001", rewrite: (path) => path.replace(/^\/snapdragons/, "") },
      "/snapdragons/auth": { target: "http://127.0.0.1:3001", rewrite: (path) => path.replace(/^\/snapdragons/, "") },
    },
  },
})
