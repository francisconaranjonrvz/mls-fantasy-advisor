import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // En desarrollo, el Worker corre aparte con `wrangler dev`.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
