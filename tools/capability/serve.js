// Interactive playground for the bank: list records, press "Test" to call Jev live, edit the state and test again.
//   node tools/capability/serve.js      # http://localhost:8790
// The key stays on the server; the page goes through the /api/ask proxy, which accepts several questions at once.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CATS, QUESTIONS, QKEYS, records } = require('./items');
const { callMany, read } = require('./run');

const PORT = Number(process.env.PORT ?? 8790);
const PAGE = path.join(__dirname, 'playground.html');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) reject(new Error('body too large')); });
  req.on('end', () => resolve(s));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(PAGE));
    }
    if (req.method === 'GET' && url === '/api/items') {
      return json(res, 200, { cats: CATS, questions: QUESTIONS, qkeys: QKEYS, records });
    }
    if (req.method === 'POST' && url === '/api/ask') {
      const body = JSON.parse(await readBody(req));
      // single: { state, question, expect: [] }; multiple: { state, questions: {k: q}, expect: {k: []} }
      const questions = body.questions ?? (body.question ? { q: body.question } : null);
      if (!questions || Object.values(questions).some((q) => !q || !q.type)) return json(res, 400, { error: 'question(s) missing type' });
      const r = await callMany(body.state ?? {}, questions);
      const expectOf = (k) => [].concat((body.questions ? body.expect?.[k] : body.expect) ?? []).map(String);
      const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { answer: r.answers[k], ...read({ q, expect: expectOf(k) }, r.answers[k]) }]));
      return json(res, 200, body.questions ? { model: r.model, ms: r.ms, answers } : { model: r.model, ms: r.ms, ...answers.q });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  jevtophoto playground  ->  http://localhost:${PORT}\n  ${records.length} records × ${QKEYS.length} questions\n`);
});
