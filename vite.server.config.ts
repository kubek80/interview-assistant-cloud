// Builds the server (server/main.ts) and the command-line tasks (server/cli.ts) into dist/server
// as plain ES modules for Node 22. Dependencies stay in node_modules (not bundled); the shared
// pure code in src/domain and src/shared is bundled in, so the image needs no TypeScript tooling.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

const deps = Object.keys(pkg.dependencies);

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    minify: false,
    rolldownOptions: {
      input: { main: 'server/main.ts', cli: 'server/cli.ts' },
      external: (id) => id.startsWith('node:') || builtinModules.includes(id) || deps.some((d) => id === d || id.startsWith(`${d}/`)),
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
  publicDir: false,
});
