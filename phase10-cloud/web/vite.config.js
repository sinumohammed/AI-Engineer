import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Port 5174 so this copy runs next to the frozen original on 5173.
// envDir: read phase10-cloud/.env, the one settings file for the whole copy.
// Only VITE_* values reach the browser, so the API keys in it stay on the server.
//
// Phase 10 UI: installable as an app (PWA) - "Add to Home Screen" on a phone,
// "Install" in desktop Chrome/Edge - opening full screen with its own icon.
// The service worker caches only the app's own files (HTML, JS, CSS, icons),
// so it starts instantly; questions always go to the live API, which is on
// another origin and never cached.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // icons generated from public/logo.svg (pwa-assets.config.js)
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Agent Chat',
        short_name: 'Agent Chat',
        description: 'Ask the company handbook, coding or general questions.',
        theme_color: '#6d5ff5',
        background_color: '#f7f7fb',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  // Libraries in their own files: an app update then re-downloads only the
  // app's own code, not React and Ant Design (~340 KB gzipped together).
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@ant-design/x-markdown') || id.includes('marked') || id.includes('dompurify')) return 'markdown'
          if (id.includes('@ant-design/x')) return 'antd-x'
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'react'
          return 'antd'
        },
      },
    },
  },
  envDir: '..',
  server: { port: 5174, strictPort: true },
})
