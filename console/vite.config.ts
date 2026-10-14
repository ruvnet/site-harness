import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: { outDir: 'dist/ui', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
