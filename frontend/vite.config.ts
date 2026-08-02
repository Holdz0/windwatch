import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing dependencies into their own chunks.
        // react/react-dom are needed for first paint; peerjs and socket.io are
        // only pulled in with the lazily-loaded Room, so keeping them separate
        // stops them from blocking the landing screen and lets each be cached
        // independently across deploys.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          // Match on path segments so 'lucide-react' isn't swept into the
          // react chunk by a naive substring test.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (/[\\/]node_modules[\\/](peerjs|socket\.io-client|engine\.io-client)[\\/]/.test(id)) {
            return 'vendor-rtc';
          }
        }
      }
    }
  }
})
