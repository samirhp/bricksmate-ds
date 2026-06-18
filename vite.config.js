import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Vendor en chunks propios: cachean aparte del código de app (que cambia a menudo)
        // y quitan el chunk único >500 KB. El editor de código ya va lazy (su propio chunk).
        manualChunks: {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
})
