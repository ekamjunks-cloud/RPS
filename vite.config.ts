import { defineConfig } from 'vite';

// base './' lets the built game run from any address, including a GitHub Pages sub-folder.
export default defineConfig({ base: './', server: { port: 5173 } });
