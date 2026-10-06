import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Port 5174 so this copy runs next to the frozen original on 5173.
// envDir: read phase10-cloud/.env, the one settings file for the whole copy.
// Only VITE_* values reach the browser, so the API keys in it stay on the server.
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { port: 5174, strictPort: true },
})
