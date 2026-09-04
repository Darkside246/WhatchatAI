import { defineConfig } from 'vitest/config';

/**
 * Tests get their own Redis database index so a developer running
 * `npm run dev` cannot consume the suite's BullMQ jobs. Sharing index 0
 * produced failures that looked like real regressions and vanished on a
 * re-run - twice. test/globalSetup.ts applies the same default for the main
 * process and refuses index 0 outright, so the isolation cannot be lost
 * silently. An explicit REDIS_URL with a real index still wins.
 */
const testRedisUrl =
  process.env.REDIS_URL && Number(new URL(process.env.REDIS_URL).pathname.replace('/', '')) > 0
    ? process.env.REDIS_URL
    : 'redis://127.0.0.1:6379/1';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupFile.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    env: { REDIS_URL: testRedisUrl },
  },
});
