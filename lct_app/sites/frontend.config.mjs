import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Never embed owner environment values or copy unrelated public artifacts.
  envDir: false,
  envPrefix: [],
  publicDir: false,
  plugins: [react(), tailwindcss()],
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log', 'console.info', 'console.debug'],
  },
  build: { outDir: 'dist/client', target: 'es2022' },
});
