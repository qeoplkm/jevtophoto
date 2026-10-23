// Serve out/ locally to view the review page (thumbnails in review.html use relative paths that some browsers block over file://).
//   node tools/extract/serve-out.js            # http://localhost:8791/downloads/review.html
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..', 'out');
const PORT = Number(process.env.PORT ?? 8791);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  let target = file;
  try { if (fs.statSync(target).isDirectory()) target = path.join(target, 'review.html'); } catch { res.writeHead(404); return res.end('not found'); }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Review page  ->  http://localhost:${PORT}/downloads/review.html`));
