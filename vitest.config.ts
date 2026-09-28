import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is src/client) so tests under src/shared are found.
export default defineConfig({
  root: '.',
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
