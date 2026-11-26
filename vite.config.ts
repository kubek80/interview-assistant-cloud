/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { serviceWorker } from './vite-plugins/serviceWorker.ts';
import { trackSchemaValidator } from './vite-plugins/trackSchemaValidator.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const DEV_STYLE_NONCE = 'vite-dev-styles';

/**
 * In dev, Vite injects CSS through <style> tags. Rather than relaxing the CSP with
 * 'unsafe-inline', give those tags a nonce that only the dev server's policy accepts.
 * The production build emits <link rel="stylesheet"> and keeps the strict policy.
 */
function devCspNonce(): Plugin {
  return {
    name: 'dev-csp-nonce',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", `style-src 'self' 'nonce-${DEV_STYLE_NONCE}'`);
    },
  };
}

/**
 * `npm run dev` only: forward /api to the local AI helper (`npm run helper`, docs/11 AI-1), which
 * accepts only its own origin (AI-4). The dev page's Origin is rewritten to the helper's own origin
 * only when it is the dev server's own origin, so other sites are still refused.
 */
const AI_HELPER_TARGET = `http://127.0.0.1:${process.env.AI_HELPER_PORT || 4173}`;
const aiHelperProxy = {
  '/api': {
    target: AI_HELPER_TARGET,
    changeOrigin: true,
    // A second opinion can take minutes; the helper has its own timeout (AI_TIMEOUT_MS).
    proxyTimeout: 10 * 60 * 1000,
    configure(proxy: { on(event: 'proxyReq', fn: (proxyReq: { setHeader(name: string, value: string): void }, req: { headers: Record<string, string | string[] | undefined> }) => void): unknown }) {
      proxy.on('proxyReq', (proxyReq, req) => {
        if (req.headers.origin && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', AI_HELPER_TARGET);
      });
    },
  },
};

export default defineConfig(({ command }) => ({
  base: './',
  server: { proxy: aiHelperProxy },
  oxc: { jsx: { runtime: 'automatic' } },
  html: command === 'serve' ? { cspNonce: DEV_STYLE_NONCE } : undefined,
  plugins: [devCspNonce(), trackSchemaValidator(root), serviceWorker(root)],
  build: {
    target: 'es2022',
    sourcemap: false,
    // One offline bundle including the 200-question seed; splitting would not help (OV-1).
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
    setupFiles: ['src/test/setup.ts'],
  },
}));
