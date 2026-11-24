import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Timeouts here are hang guards only, never the thing a test checks.
    // Tests wait on events (server close, chat status, child exit); on a slow or
    // busy runner the first import of `ai` and `@ag-ui/client` alone can take
    // tens of seconds, so the guard is set well above that.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
