/**
 * Optional local server for Executive Tabletop D20.
 *
 * The core app is 100% browser-side and works served statically (or even
 * offline once WebLLM weights + library are vendored). This server adds two
 * conveniences:
 *
 *   1. Static file serving (dev convenience) -> http://localhost:8000
 *   2. GET /api/company?url=<url>   A CORS workaround for the optional company
 *      info feature. Browsers block cross-origin fetches to many sites, so
 *      this proxy fetches the page server-side and returns a small readable
 *      summary. This endpoint is optional and only used when a scenario sets
 *      a company_url AND the browser-side fetch is blocked.
 *
 * Run:  npm start   (or)   node server/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';

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

async function companyProxy(req, res, url) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Only http/https URLs are allowed.');
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const upstream = await fetch(target, { signal: ctrl.signal, headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const html = await upstream.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const desc =
      (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1] ||
      (html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i) || [])[1] || '';
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const summary = [clean(title) && `Title: ${clean(title)}`, clean(desc) && `Description: ${clean(desc)}`]
      .filter(Boolean)
      .join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(summary || `Fetched ${target} but found no readable summary.`);
  } catch {
    clearTimeout(t);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Could not fetch that URL (blocked, unreachable, or timed out).');
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

  if (pathname === '/api/company') {
    return companyProxy(req, res, url.searchParams.get('url') || '');
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Executive Tabletop D20 -> http://localhost:${PORT}`);
  console.log('Company-info proxy available at /api/company?url=<url> (optional)');
});
