import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/wc2026-bets/',
  test: {
    environment: 'node',
    globals: true,
  },
})
