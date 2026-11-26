// Server tests against a real PostgreSQL (HOST-8): `npm run test:server`. Start one first with
// `npm run db:start` (or point TEST_DATABASE_URL at any PostgreSQL 16 the user may create databases on).
// globalSetup migrates a template database once; every test file then gets its own database cloned
// from it (server/test/harness.ts), so files run in parallel without seeing each other's data.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['server/test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
