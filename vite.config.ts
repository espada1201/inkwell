import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
