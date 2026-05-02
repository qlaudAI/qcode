import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Tauri's webview only has access to a fixed port, so we lock vite
// to 1420 to match src-tauri/tauri.conf.json's "devUrl".
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split big leaf deps into their own chunks so the main
        // bundle stays small. PostHog (~140kb) and TanStack Query
        // (~45kb) load lazily without blocking first paint;
        // lucide-react is tree-shaken at use-site already so we
        // don't try to preempt its chunk shape.
        manualChunks: {
          react: ['react', 'react-dom'],
          query: ['@tanstack/react-query'],
          analytics: ['posthog-js'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
