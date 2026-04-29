import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  publicDir: 'public-assets',
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'public/index.html'),
    },
  },
})
