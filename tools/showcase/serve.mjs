// Start the Vite dev server for the showcase capture: its own port, no HMR and no file watching, so an edit
// elsewhere in the repo during a capture never reloads the page mid-shot. The DEV build is required:
// capture.mjs drives the game through window.__voidswarm, which only exists when import.meta.env.DEV.
//
// Standalone: node tools/showcase/serve.mjs [port]   (Ctrl+C to stop)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startVite(port = 5391) {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(ROOT, 'vite.config.ts'),
    root: join(ROOT, 'src', 'client'),
    logLevel: 'warn',
    clearScreen: false,
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 5391;
  const s = await startVite(port);
  console.log(`showcase vite on ${s.url} (no HMR, no watch). Ctrl+C to stop.`);
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
