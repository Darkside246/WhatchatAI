import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // This repo keeps ONE .env at the repo root for everything (backend and
  // now this) rather than a second, easy-to-forget src/web/.env - Vite's
  // own default envDir is its own project root (src/web), so without this
  // override a VITE_-prefixed var set in the real .env (e.g.
  // VITE_RECAPTCHA_SITE_KEY) would silently never reach the frontend build.
  envDir: '../..',
  server: {
    host: true,
    port: process.env['PORT'] ? Number(process.env['PORT']) : 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // @xyflow/react (the agent canvas builder) is only needed on
        // /agents - keep it out of every other route's chunk. This build
        // uses Vite's rolldown bundler, which requires manualChunks as a
        // function rather than the classic Rollup object-map form.
        manualChunks(id: string) {
          if (id.includes('node_modules/@xyflow')) return 'xyflow';
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router-dom') ||
            /node_modules\/react\//.test(id)
          ) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
