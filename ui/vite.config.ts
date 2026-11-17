// Authored by Tomás Neto (TN 2026)
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const api = process.env.MG_API ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          tanstack: ['@tanstack/react-router', '@tanstack/react-query'],
          charts: ['recharts'],
          radix: ['radix-ui', 'cmdk', 'sonner'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/admin': { target: api, changeOrigin: false }, '/v1': api, '/health': api },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
