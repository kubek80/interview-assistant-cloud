/// <reference types="vitest/config" />
// The browser app: `npm run dev:client` (with the API proxied to `npm run dev:server`) and the
// production build into dist/client, which the server serves on the same origin (HOST-2).
import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.PORT || 8080}`;

export default defineConfig({
  base: '/',
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    port: 5173,
    strictPort: true,
    // Same origin in development too: the dev server forwards /api and /healthz to the API server,
    // keeping the Host header so cookies and the Origin check behave as in production.
    proxy: { '/api': { target: API, changeOrigin: false, xfwd: true }, '/healthz': { target: API } },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return; // react-router's "use client"
        warn(warning);
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The local app's IndexedDB layer is kept for reference only (README "Porting a screen").
    exclude: ['src/db-local/**', 'node_modules/**'],
  },
});
