import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, host: true },
});
