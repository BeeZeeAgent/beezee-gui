import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../app'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://localhost:3000',
      '/v1': 'http://localhost:3000',
      '/sync': { target: 'ws://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
      '/gm': 'http://localhost:3000',
    },
  },
});
