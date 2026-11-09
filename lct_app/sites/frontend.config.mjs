import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Never embed owner environment values or copy unrelated public artifacts.
  envDir: false,
  envPrefix: [],
  define: { 'import.meta.env.VITE_SITES_MODE': JSON.stringify('true') },
  publicDir: false,
  // Search explicitly uses CPU/WASM; avoid bundling unused GPU runtimes.
  resolve: { alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' }] },
  plugins: [react(), tailwindcss()],
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log', 'console.info', 'console.debug'],
  },
  build: { outDir: 'dist/client', target: 'es2022' },
});
