// Run the whole bank against Jev. Both questions of a record (junk / kind) go in one call —
// questions in the same request don't interfere with each other. Raw responses go to .raw.json,
// parsed results to results.json; report.js builds RESULTS.md from them.
//
//   node tools/capability/run.js                 # all records × 3 runs
//   REPS=1 ONLY=chat,receipt node tools/capability/run.js
//   ONLY=chat-old-400d node tools/capability/run.js
//   EDGE=1 node tools/capability/run.js          # borderline cases only
//   PROFILE=aggressive node tools/capability/run.js
const fs = require('node:fs');
const path = require('node:path');
const { CATS, QKEYS, PROFILES, records, items } = require('./items');

// The key comes from the environment or the project's .env, and is read only when Jev is actually called:
// offline scripts such as report.js and ablate.js require this file and must work without a key.
const ROOT = path.join(__dirname, '..', '..');
let apiKey = null;
function getApiKey() {
  if (apiKey) return apiKey;
  apiKey = process.env.OPENROUTER_API_KEY || null;
  const envFile = path.join(ROOT, '.env');
  if (!apiKey && fs.existsSync(envFile)) {
    for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = l.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/);
      if (m && m[1]) apiKey = m[1];
    }
  }
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not found. Copy .env.example to .env and add your OpenRouter key, or set OPENROUTER_API_KEY in the environment.');
  return apiKey;
}

const REPS = Number(process.env.REPS ?? 3);
const CONC = Number(process.env.CONC ?? 4);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const EDGE = process.env.EDGE === '1';
const PROFILE = process.env.PROFILE ?? null;   // PROFILE=aggressive swaps in a different set of junk criteria (PROFILES in items.js)
if (PROFILE && !PROFILES[PROFILE]) throw new Error(`Unknown PROFILE "${PROFILE}". Available: ${Object.keys(PROFILES).join(', ')}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Several questions in one request; returns { model, answers: {key: answer}, ms }
async function callMany(state, questions) {
  const body = JSON.stringify({ model: '~typesafe/jev-latest', state, questions });
  const key = getApiKey(); // a configuration problem is not retried
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      });
      const text = await res.text();
      if ([401, 402, 403].includes(res.status)) {
        // A bad, expired or unfunded key will not fix itself: stop instead of retrying every call.
        throw Object.assign(new Error(`OpenRouter rejected the API key (${res.status}): ${text.slice(0, 160)}`), { fatal: true });
      }
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
      const d = JSON.parse(text);
      for (const k of Object.keys(questions)) if (!d.answers || !d.answers[k]) throw new Error(`response has no answers.${k}: ${text.slice(0, 200)}`);
      return { model: d.model, answers: d.answers, ms: Date.now() - t0 };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}
// single-question version, used by the playground
async function call(state, question) {
  const r = await callMany(state, { q: question });
  return { model: r.model, answer: r.answers.q, ms: r.ms };
}

// Mode, confidence, and probability mass on the expected answer. Score questions key probabilities "0".."n",
// choice questions by choice key. Normalized to { dist: {key: p}, mode, top, expectMass }.
function read(item, answer) {
  const probs = answer.probabilities ?? {};
  const keys = item.q.type === 'score' ? item.q.criteria.map((_, i) => String(i)) : Object.keys(item.q.criteria);
  const dist = Object.fromEntries(keys.map((k) => [k, probs[k] ?? 0]));
  const expectKeys = item.expect.map(String);
  let mode = keys[0];
  for (const k of keys) if (dist[k] > dist[mode]) mode = k;
  const ranked = [...keys].sort((a, b) => dist[b] - dist[a]);
  return {
    dist,
    mode,
    top: dist[mode],
    lead: Number((dist[ranked[0]] - (dist[ranked[1]] ?? 0)).toFixed(3)),
    correct: expectKeys.includes(mode),
    expectMass: Number(expectKeys.reduce((s, k) => s + (dist[k] ?? 0), 0).toFixed(3)),
    confidence: answer.confidence ?? null,
    score: answer.score ?? null,
    choice: answer.choice ?? null,
  };
}

// Run a batch of records. opts: { todo, reps, conc, tag, transformState?, transformQ?, quiet? }
// transformState / transformQ are for ablations: change exactly one thing on the same bank (ablate.js).
async function runBank(opts) {
  const { todo, reps = REPS, conc = CONC, tag = '', transformState = (s) => s, transformQ = (q) => q, quiet = false } = opts;
  const log = quiet ? () => {} : console.log;
  getApiKey(); // check the key first: otherwise every call fails and results*.json gets overwritten with error rows
  const itemsOf = Object.fromEntries(todo.map((r) => [r.id, items.filter((it) => it.rec === r.id).map((it) => ({ ...it, state: transformState(it.state, it), q: transformQ(it.q) }))]));
  const jobs = [];
  for (const r of todo) for (let rep = 0; rep < reps; rep++) jobs.push({ r, rep });
  // interleave: repeats of the same record are not adjacent, to avoid short-term correlation
  jobs.sort((a, b) => a.rep - b.rep || 0);

  log(`${todo.length} records × ${reps} runs = ${jobs.length} calls (${QKEYS.length} questions each), concurrency ${conc}`);
  const raw = [];
  const runs = {};
  let done = 0;
  let model = null;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { r, rep } = jobs[next++];
      const its = itemsOf[r.id];
      const questions = Object.fromEntries(its.map((it) => [it.qkey, it.q]));
      try {
        const res = await callMany(its[0].state, questions);
        model = res.model;
        raw.push({ rec: r.id, rep, model: res.model, answers: res.answers, ms: res.ms });
        for (const it of its) (runs[it.id] ??= [])[rep] = { ...read(it, res.answers[it.qkey]), ms: res.ms };
      } catch (e) {
        if (e.fatal) throw e; // abort the whole batch before anything is written
        raw.push({ rec: r.id, rep, error: String(e.message) });
        for (const it of its) (runs[it.id] ??= [])[rep] = { error: String(e.message) };
        console.log(`  ✗ ${r.id} #${rep}: ${e.message}`);
      }
      done++;
      if (!quiet && (done % 25 === 0 || done === jobs.length)) process.stdout.write(`  ${done}/${jobs.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  const results = todo.flatMap((r) => itemsOf[r.id].map((it) => ({
    id: it.id, rec: it.rec, qkey: it.qkey, cat: it.cat, catLabel: CATS[it.cat], edge: it.edge, note: it.note ?? null,
    state: it.state, q: it.q, expect: it.expect.map(String),
    runs: runs[it.id] ?? [],
  })));
  const out = { model, ranAt: new Date().toISOString(), reps, tag: tag || null, cats: CATS, qkeys: QKEYS,
    records: todo.map((r) => ({ id: r.id, cat: r.cat, edge: r.edge, note: r.note, expect: r.expect })), results };
  fs.writeFileSync(path.join(__dirname, `.raw${tag}.json`), JSON.stringify(raw));
  fs.writeFileSync(path.join(__dirname, `results${tag}.json`), JSON.stringify(out, null, 1));
  return out;
}

async function main() {
  const todo = records.filter((r) => (!EDGE || r.edge) && (!ONLY || ONLY.includes(r.cat) || ONLY.includes(r.id)));
  const tag = [PROFILE && `profile-${PROFILE}`, EDGE && 'edge', ONLY && ONLY.join('+')].filter(Boolean).map((t) => `-${t.replace(/[^\w+-]/g, '')}`).join('');
  const { model, results } = await runBank({ todo, tag, transformQ: PROFILE ? (q) => PROFILES[PROFILE].questions[q.type === 'score' ? 'junk' : 'kind'] : (q) => q });

  // terminal summary: per question × category
  console.log(`\nmodel ${model}`);
  for (const qk of QKEYS) {
    console.log(`\n[${qk}]`);
    const byCat = {};
    for (const r of results.filter((x) => x.qkey === qk)) {
      const ok = r.runs.filter((x) => !x.error);
      const c = (byCat[r.cat] ??= { n: 0, correct: 0, conf: [] });
      for (const x of ok) { c.n++; if (x.correct) c.correct++; c.conf.push(x.confidence ?? 0); }
    }
    for (const [cat, c] of Object.entries(byCat)) {
      const mc = c.conf.length ? (c.conf.reduce((s, v) => s + v, 0) / c.conf.length).toFixed(2) : '-';
      console.log(`  ${cat.padEnd(16)} ${String(c.correct).padStart(3)}/${String(c.n).padEnd(3)} ${(100 * c.correct / c.n).toFixed(0).padStart(3)}%  mean confidence ${mc}`);
    }
  }
  const wrong = results.filter((r) => r.runs.some((x) => !x.error && !x.correct));
  if (wrong.length) {
    console.log('\nItems answered wrong at least once:');
    for (const r of wrong) {
      const modes = r.runs.map((x) => (x.error ? '!' : x.mode)).join(' ');
      console.log(`  ${(r.edge ? '⚑ ' : '  ') + r.id.padEnd(34)} expected ${r.expect.join('|').padEnd(22)} got ${modes}`);
    }
  }
  console.log(`\nWrote tools/capability/results${tag}.json`);
}

module.exports = { call, callMany, read, runBank };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
