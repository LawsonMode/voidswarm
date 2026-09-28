import { defineConfig } from 'vite';

/** '/voidswarm' | 'voidswarm/' | '' → '/voidswarm/' | '/' (Vite wants a leading and trailing slash). */
function normalizeBase(b: string): string {
  const t = b.trim().replace(/^\/+|\/+$/g, '');
  return t ? `/${t}/` : '/';
}

// `npm run build`       → base '/' (served at the root by `npm start` / the game server).
// `npm run build:pages` → `vite build --mode pages`: the static GitHub Pages client under
//                         https://lawsonmode.github.io/voidswarm/ (base '/voidswarm/'). In this mode the client
//                         also knows it has no same-origin game server (see src/client/net/serverUrl.ts).
// VITE_BASE=/sub/path/  → overrides the base in any mode (a fork's Pages site, another static host).
// Only index.html is built; the dev harnesses (render-demo.html, music-demo.html) are served by `npm run dev` only.
export default defineConfig(({ mode }) => ({
  root: 'src/client',
  base: normalizeBase(process.env.VITE_BASE ?? (mode === 'pages' ? '/voidswarm/' : '/')),
  publicDir: false,
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, host: true },
}));
