import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  base: './',
  // `npm run phone`: phones only expose motion sensors to HTTPS pages, so serve with a local certificate.
  plugins: mode === 'phone' ? [basicSsl({ name: 'tremor' })] : [],
  build: { chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  test: { include: ['tests/unit/**/*.test.ts'] },
}));
