// 把题库全部跑一遍。改自作者早先的 Jev 能力探针（不在本仓库）：call/read 原样，
// 区别是同一条记录的三问（junk / kind / keep）合并成一次调用（同一请求内的问题互不干扰，JEV-GUIDE 第四节），
// 71 条记录 × 3 次 = 213 次调用。原始返回落在 .raw.json，整理后的结果在 results.json，报告由 report.js 生成。
//
//   node tools/capability/run.js                 # 全部记录 × 3 次
//   REPS=1 ONLY=chat,receipt node tools/capability/run.js
//   ONLY=chat-old-unviewed node tools/capability/run.js
//   EDGE=1 node tools/capability/run.js          # 只跑边界案例
const fs = require('node:fs');
const path = require('node:path');
const { CATS, QKEYS, PROFILES, records, items } = require('./items');

// Key 只从环境变量或项目根目录的 .env 读，而且等到真要调 Jev 时才读：
// report.js / ablate.js 等离线脚本会 require 这个文件，没有 key 也必须能跑。
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
const PROFILE = process.env.PROFILE ?? null;   // PROFILE=aggressive 换一套 junk 判断标准（items.js 的 PROFILES）
if (PROFILE && !PROFILES[PROFILE]) throw new Error(`Unknown PROFILE "${PROFILE}". Available: ${Object.keys(PROFILES).join(', ')}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次请求带多个问题；返回 { model, answers: {key: answer}, ms }
async function callMany(state, questions) {
  const body = JSON.stringify({ model: '~typesafe/jev-latest', state, questions });
  const key = getApiKey(); // 配置问题不重试，直接报
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
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
      const d = JSON.parse(text);
      for (const k of Object.keys(questions)) if (!d.answers || !d.answers[k]) throw new Error(`response has no answers.${k}: ${text.slice(0, 200)}`);
      return { model: d.model, answers: d.answers, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}
// 单问版本，playground 用
async function call(state, question) {
  const r = await callMany(state, { q: question });
  return { model: r.model, answer: r.answers.q, ms: r.ms };
}

// 众数、置信度、标准答案上的概率质量。score 题的 probabilities 键是 "0".."n"，
// choice 题的键是 choice key。统一成 { dist: {key: p}, mode, top, expectMass }。
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

// 跑一批记录。opts: { todo, reps, conc, tag, transformState?, transformQ?, quiet? }
// transformState / transformQ 给消融实验用：同一题库只改一件事（ablate.js）。
async function runBank(opts) {
  const { todo, reps = REPS, conc = CONC, tag = '', transformState = (s) => s, transformQ = (q) => q, quiet = false } = opts;
  const log = quiet ? () => {} : console.log;
  getApiKey(); // 先确认有 key：否则每条都报错，还会用错误行覆盖 results*.json
  const itemsOf = Object.fromEntries(todo.map((r) => [r.id, items.filter((it) => it.rec === r.id).map((it) => ({ ...it, state: transformState(it.state, it), q: transformQ(it.q) }))]));
  const jobs = [];
  for (const r of todo) for (let rep = 0; rep < reps; rep++) jobs.push({ r, rep });
  // 交错：同一条记录的各次重复不相邻，避免短时状态相关
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

  // 终端摘要：按问题 × 类别
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
