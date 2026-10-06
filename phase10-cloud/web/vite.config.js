import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Port 5174 so this copy runs next to the frozen original on 5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
})
