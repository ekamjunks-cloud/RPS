import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' lets the built game run from any address, including a GitHub Pages sub-folder.
// Two pages: the game (index.html) and the admin page (admin.html).
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin.html') } } },
});
