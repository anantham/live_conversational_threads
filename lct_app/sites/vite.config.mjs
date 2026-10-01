import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // This artifact never consumes local environment files or browser secrets.
  envDir: false,
  build: {
    outDir: 'dist/server',
    target: 'es2022',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./worker.js', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js',
    },
  },
});
