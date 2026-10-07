/**
 * Optional local server for Executive Tabletop D20.
 *
 * The app runs on API keys and can be served statically. This server adds two
 * conveniences:
 *
 *   1. Static file serving (dev convenience) -> http://localhost:8000
 *   2. The /api/* routes backed by ./api.js (session persistence, report export).
 *
 * Run:  npm start   (or)   node server/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, restoreSessions } from './api.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  // Default to index.html for '/'.
  let filePath = normalize(join(ROOT, pathname));
  if (pathname === '/' || pathname === '') filePath = join(ROOT, 'index.html');

  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // API routes first.
  if (pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, pathname, url);
    if (handled) return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, async () => {
  const restored = await restoreSessions();
  console.log(`Executive Tabletop D20 -> http://localhost:${PORT}`);
  console.log(`Restored ${restored} persisted session(s).`);
  console.log('Serving the tabletop app (static + /api).');
  console.log('API: /api/scenarios, /api/session, /api/session/:id/turn, /api/session/:id/report');
});
