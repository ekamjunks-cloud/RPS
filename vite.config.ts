import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' lets the built game run from any address, including a GitHub Pages sub-folder.
// Two pages: the game (index.html) and the admin page (admin.html).
// The guide pages live in public/<page>/index.html. GitHub Pages serves "/<page>/" from that file;
// the dev server would hand back the game instead, so point those addresses at the files here too.
const GUIDE_PAGES = /^\/(rock-paper-scissors|how-to-play|strategy)\/?(\?.*)?$/;
const guidePages = {
  name: 'guide-pages',
  configureServer(server: any) {
    server.middlewares.use((req: any, _res: any, next: any) => {
      const m = GUIDE_PAGES.exec(req.url || '');
      if (m) req.url = `/${m[1]}/index.html`;
      next();
    });
  },
};

export default defineConfig({
  base: './',
  plugins: [guidePages],
  server: { port: 5173 },
  build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin.html') } } },
});
