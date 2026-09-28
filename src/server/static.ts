// OWNER: ROOM agent. Minimal static file handler (for `--serve dist`): MIME types, SPA fallback, no traversal.
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function createStaticHandler(dir: string): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    let rel: string;
    try { rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (rel.includes('\0')) { res.writeHead(400).end(); return; }
    const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    let file = isFile(target) ? target : '';
    if (!file) {
      // SPA fallback for extensionless routes; real missing assets 404
      if (path.extname(target) && path.extname(target) !== '.html') { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      file = index;
      if (!isFile(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found (build the client first: npm run build)'); return; }
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
    headers['Cache-Control'] = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}
