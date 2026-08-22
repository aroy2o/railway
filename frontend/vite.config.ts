import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // VITE_* variables are read from the shared repo-root .env rather than a
  // second copy inside /frontend, so all three services configure from one
  // file. See docs/DECISIONS.md D-002.
  envDir: path.resolve(here, '..'),

  server: {
    port: 5173,
    strictPort: true,
  },
})
