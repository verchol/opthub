import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The hub (node hub.mjs, port 8899 by default) owns /api and the static report routes;
// `npm run dev` proxies them so the page can be worked on with hot reload.
const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:8899'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { proxy: Object.fromEntries(['/api', '/triage', '/atlas', '/results', '/docs', '/config', '/optlog'].map((p) => [p, HUB])) },
})
