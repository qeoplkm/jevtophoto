// 把 results.json 整理成 RESULTS.md（结论）和 report.html（逐条明细，可筛选）。
// 回答 README 测试计划 A 要看的三件事：准确率、置信度能不能把模糊案例挑出来、三次重跑稳不稳，
// 「必须回答的对照问题」：Jev 比 isUtility + 规则多了什么——v3 起按「规则 + Jev」的端到端来比。
//   node tools/capability/report.js
const fs = require('node:fs');
const path = require('node:path');
const { CATS, QKEYS, QUESTIONS, records } = require('./items');
const { BASELINES, levelDecision, goldDecisions } = require('./baseline');
const { applyRules, decide, DEFAULT_TAU, RECENT_SCREENSHOT_DAYS } = require('./rules');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => { try { return readJson(f); } catch { return null; } };
const R = readJson(path.join(__dirname, 'results.json'));
const labelOf = (q, k) => (q.type === 'score' ? q.criteria[Number(k)] : k); // choice 题直接用 key，criteria 原文太长
const lab = (qk, k) => labelOf(QUESTIONS[qk], k);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const majority = (modes) => { const c = {}; for (const m of modes) c[m] = (c[m] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
const decZh = { delete: '删', unsure: '说不准', keep: '留' };
const colZh = { delete: '建议删除', unsure: '拿不准', keep: '保留' };
const fmtList = (rs, f = (r) => `\`${r.id}\``) => rs.map(f).join('、') || '无';

// ---------- 按记录整理 ----------
const items = R.results.filter((it) => it.runs.every((x) => !x.error));
const byRec = {};
for (const it of items) {
  const rec = (byRec[it.rec] ??= { id: it.rec, cat: it.cat, edge: it.edge, note: it.note, state: it.state, q: {} });
  const modes = it.runs.map((x) => x.mode);
  const maj = majority(modes);
  rec.q[it.qkey] = {
    expect: it.expect, runs: it.runs, modes, maj, majCorrect: it.expect.includes(maj),
    correctRuns: it.runs.filter((x) => x.correct).length,
    conf: mean(it.runs.map((x) => x.confidence ?? 0)),
    flips: new Set(modes).size - 1,
    topSd: sd(it.runs.map((x) => x.dist[maj])),
    avgDist: Object.fromEntries(Object.keys(it.runs[0].dist).map((k) => [k, mean(it.runs.map((x) => x.dist[k]))])),
  };
}
const recs = Object.values(byRec).filter((r) => QKEYS.every((k) => r.q[k]));
for (const r of recs) {
  const j = r.q.junk;
  r.gold = goldDecisions(j.expect);
  r.jevDecision = levelDecision(j.maj);
  r.baseline = Object.fromEntries(Object.entries(BASELINES).map(([n, fn]) => [n, fn(r.state)]));
  r.rule = applyRules(r.state);
  // 端到端：按次（产品里一次调用就是一次）和按三次众数各算一份
  r.pipeRuns = j.runs.map((x) => decide(r.state, { mode: x.mode, confidence: x.confidence }, DEFAULT_TAU));
  r.pipe = decide(r.state, { mode: j.maj, confidence: j.conf }, DEFAULT_TAU);
}
const clear = recs.filter((r) => !r.edge && r.cat !== 'robust');
const edge = recs.filter((r) => r.edge);
const isKeepOnly = (r) => r.gold.every((d) => d === 'keep');
const isDeleteOnly = (r) => r.gold.every((d) => d === 'delete');

// ---------- 1. Jev 单独看 ----------
const runAcc = (rs, qk) => { let ok = 0, n = 0; for (const r of rs) { ok += r.q[qk].correctRuns; n += r.q[qk].runs.length; } return { ok, n }; };
const majAcc = (rs, qk) => ({ ok: rs.filter((r) => r.q[qk].majCorrect).length, n: rs.length });
const accTable = QKEYS.map((qk) => ({ qk, all: runAcc(recs, qk), clear: runAcc(clear, qk), edge: runAcc(edge, qk), maj: majAcc(recs, qk) }));
const decAcc = (rs) => { let ok = 0, n = 0; for (const r of rs) for (const x of r.q.junk.runs) { n++; if (r.gold.includes(levelDecision(x.mode))) ok++; } return { ok, n }; };
const catRows = Object.keys(CATS).map((cat) => {
  const rs = recs.filter((r) => r.cat === cat);
  if (!rs.length) return null;
  return { cat, n: rs.length, edge: rs.filter((r) => r.edge).length, ...Object.fromEntries(QKEYS.map((qk) => [qk, runAcc(rs, qk)])), conf: mean(rs.map((r) => r.q.junk.conf)) };
}).filter(Boolean);
const harmful = recs.filter((r) => isKeepOnly(r) && r.jevDecision === 'delete');
const missed = recs.filter((r) => isDeleteOnly(r) && r.jevDecision === 'keep');

// ---------- 2. 端到端：规则 + Jev ----------
const pipeCol = (rs, col) => rs.filter((r) => r.pipe.column === col);
const pipeHarm = recs.filter((r) => isKeepOnly(r) && r.pipe.column === 'delete');
const pipeMiss = recs.filter((r) => isDeleteOnly(r) && r.pipe.column === 'keep');
const pipeWrong = recs.filter((r) => r.pipe.column !== 'unsure' && !r.gold.includes(r.pipe.column));
const pipeUnsureClear = recs.filter((r) => r.pipe.column === 'unsure' && !r.edge && r.cat !== 'robust');
const byRule = recs.filter((r) => r.pipe.by === 'rule'), byJev = recs.filter((r) => r.pipe.by === 'jev');
const pipeRunStats = (() => {
  let n = 0, harm = 0, miss = 0, unsure = 0, del = 0, keep = 0;
  for (const r of recs) for (const p of r.pipeRuns) { n++; if (p.column === 'unsure') unsure++; else if (p.column === 'delete') { del++; if (isKeepOnly(r)) harm++; } else { keep++; if (isDeleteOnly(r)) miss++; } }
  return { n, harm, miss, unsure, del, keep };
})();
// 对照：基线（只有删 / 留）、Jev 单独（众数）、规则 + Jev
const scored = recs.filter((r) => r.cat !== 'robust');
// 「对」= 栏位在标准答案里；「拿不准」是交给人，不算错也不算对，单独计数
const cmpRow = (getDecision) => {
  const rows = scored.map((r) => ({ r, d: getDecision(r) }));
  return {
    ok: rows.filter((x) => x.r.gold.includes(x.d)).length, n: rows.length,
    okClear: rows.filter((x) => !x.r.edge && x.r.gold.includes(x.d)).length, nClear: rows.filter((x) => !x.r.edge).length,
    okEdge: rows.filter((x) => x.r.edge && x.r.gold.includes(x.d)).length, nEdge: rows.filter((x) => x.r.edge).length,
    wrong: rows.filter((x) => x.d !== 'unsure' && !x.r.gold.includes(x.d)).length,
    harm: rows.filter((x) => x.d === 'delete' && isKeepOnly(x.r)).length, miss: rows.filter((x) => x.d === 'keep' && isDeleteOnly(x.r)).length,
    unsure: rows.filter((x) => x.d === 'unsure').length,
  };
};
const cmp = {
  rules3: cmpRow((r) => r.baseline.rules3.decision),
  utility: cmpRow((r) => r.baseline.utility.decision),
  jev: cmpRow((r) => r.jevDecision),
  pipeline: cmpRow((r) => r.pipe.column),
};
const dis = scored.filter((r) => r.baseline.utility.decision !== r.pipe.column);
const pipeOk = (r) => r.gold.includes(r.pipe.column), baseOk = (r) => r.gold.includes(r.baseline.utility.decision), pipePunt = (r) => r.pipe.column === 'unsure';
const pipeWins = dis.filter((r) => pipeOk(r) && !pipePunt(r) && !baseOk(r));
const puntWins = dis.filter((r) => pipePunt(r) && !baseOk(r));
const basePunt = dis.filter((r) => pipePunt(r) && baseOk(r));
const baseWins = dis.filter((r) => !pipeOk(r) && !pipePunt(r) && baseOk(r));
const bothWrong = dis.filter((r) => !pipeOk(r) && !pipePunt(r) && !baseOk(r));

// ---------- 3. 置信度门（Jev 单独，按次） ----------
const junkRuns = (rs) => rs.flatMap((r) => r.q.junk.runs.map((x) => ({ ...x, rec: r })));
const clearOk = junkRuns(clear).filter((x) => x.correct), clearBad = junkRuns(clear).filter((x) => !x.correct), edgeRuns = junkRuns(edge);
const confSummary = { clearOk: mean(clearOk.map((x) => x.confidence)), clearBad: mean(clearBad.map((x) => x.confidence)), edge: mean(edgeRuns.map((x) => x.confidence)),
  clearMode2: clearOk.filter((x) => x.mode === '2').length, clearBadMode2: clearBad.filter((x) => x.mode === '2').length, edgeMode2: edgeRuns.filter((x) => x.mode === '2').length };
const allRuns = junkRuns(recs);
const gate = (tau) => {
  const col = (x) => { if ((x.confidence ?? 0) < tau || x.mode === '2') return 'unsure'; return x.mode === '3' ? 'keep' : 'delete'; };
  const rows = allRuns.map((x) => ({ x, col: col(x) }));
  return { tau,
    del: rows.filter((y) => y.col === 'delete').length, unsure: rows.filter((y) => y.col === 'unsure').length, keep: rows.filter((y) => y.col === 'keep').length,
    harm: rows.filter((y) => y.col === 'delete' && isKeepOnly(y.x.rec)).length,
    junkCaught: rows.filter((y) => y.col === 'delete' && isDeleteOnly(y.x.rec)).length, junkTotal: rows.filter((y) => isDeleteOnly(y.x.rec)).length,
    edgeUnsure: rows.filter((y) => y.col === 'unsure' && y.x.rec.edge).length, edgeTotal: rows.filter((y) => y.x.rec.edge).length,
    clearUnsure: rows.filter((y) => y.col === 'unsure' && !y.x.rec.edge).length, clearTotal: rows.filter((y) => !y.x.rec.edge).length,
    keepWrong: rows.filter((y) => y.col === 'keep' && !y.x.rec.gold.includes('keep')).length };
};
const gates = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map(gate);
const safeTau = gates.find((g) => g.harm === 0);

// ---------- 4. 稳定性 ----------
const decFlip = (r) => new Set(r.q.junk.modes.map(levelDecision)).size > 1;
const flipRows = QKEYS.map((qk) => ({ qk,
  flipped: recs.filter((r) => r.q[qk].flips > 0).length, flippedEdge: edge.filter((r) => r.q[qk].flips > 0).length, flippedClear: clear.filter((r) => r.q[qk].flips > 0).length,
  decFlipped: qk === 'junk' ? recs.filter(decFlip).length : null, topSd: mean(recs.map((r) => r.q[qk].topSd)) }));
const flippers = recs.flatMap((r) => QKEYS.filter((qk) => r.q[qk].flips > 0).map((qk) => ({ r, qk })));
const pipeFlip = recs.filter((r) => new Set(r.pipeRuns.map((p) => p.column)).size > 1);

// ---------- 5. 注入 ----------
const inj = byRec['inject-caption'], injBase = byRec['chat-old-400d'];
const distStr = (qk, d) => Object.entries(d).filter(([, p]) => p >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${lab(qk, k)} ${p.toFixed(2)}`).join(' / ');

// ---------- 6. 和 v1 / v2 的同题对照（junk） ----------
const V1_MAP = { 'chat-old-400d': 'chat-old-unviewed', 'chat-iphone13-150d': 'chat-android-old', 'receipt-shot-400d': 'receipt-shot-old', 'receipt-cam-500d': 'receipt-cam-old',
  'burst-autopick-sharpest': 'burst-sharpest-face', 'burst-autopick-landscape': 'burst-sharpest-landscape', 'rapidfire-not-burst': 'rapidfire-not-flagged-burst',
  'portrait-depth-effect': 'portrait', 'landscape-hdr-500d': 'landscape-old-unviewed' };
const older = [
  { name: 'v1', desc: '手编 schema（扁平、有 days_since_last_viewed / source、美学分 0–1）', data: tryJson(path.join(__dirname, 'archive-v1', 'results.json')), map: (id) => V1_MAP[id] ?? id },
  { name: 'v2', desc: 'PhotoKit schema，三问（kind 九类 + keep）', data: tryJson(path.join(__dirname, 'archive-v2', 'results.json')), map: (id) => id },
].filter((o) => o.data);
const vmaj = (it) => majority(it.runs.map((x) => x.mode));
for (const o of older) {
  const byItem = Object.fromEntries(o.data.results.map((it) => [it.id, it]));
  o.pairs = recs.map((r) => ({ r, it: byItem[`${o.map(r.id)}.junk`] })).filter((x) => x.it && x.it.runs.every((y) => !y.error));
  o.ok = o.pairs.filter((x) => x.it.expect.includes(vmaj(x.it))).length;
  o.nowOk = o.pairs.filter((x) => x.r.q.junk.majCorrect).length;
  o.conf = mean(o.pairs.map((x) => mean(x.it.runs.map((y) => y.confidence ?? 0))));
  o.nowConf = mean(o.pairs.map((x) => x.r.q.junk.conf));
  o.moved = o.pairs.filter((x) => levelDecision(vmaj(x.it)) !== levelDecision(x.r.q.junk.maj));
}

// ---------- 7. 消融（v2 上做的，junk 题没变，结论照用） ----------
const ablDir = fs.existsSync(path.join(__dirname, 'archive-v2')) ? path.join(__dirname, 'archive-v2') : __dirname;
const ablMain = tryJson(path.join(ablDir, 'results.json'));
const ablations = fs.readdirSync(ablDir).filter((f) => /^results-ablation-.*\.json$/.test(f)).map((f) => readJson(path.join(ablDir, f)));
let ABL_DESC = {};
try { ABL_DESC = Object.fromEntries(Object.entries(require('./ablate').ABLATIONS).map(([k, v]) => [k, v.desc])); } catch { /* 无所谓 */ }
const ablRow = (res) => {
  const js = res.results.filter((it) => it.qkey === 'junk' && it.runs.every((x) => !x.error));
  const acc = (rs) => { let ok = 0, n = 0; for (const it of rs) for (const x of it.runs) { n++; if (x.correct) ok++; } return { ok, n }; };
  const m = js.map((it) => ({ it, maj: majority(it.runs.map((x) => x.mode)), gold: goldDecisions(it.expect) }));
  return { clear: acc(js.filter((it) => !it.edge && it.cat !== 'robust')), edge: acc(js.filter((it) => it.edge)), conf: mean(js.flatMap((it) => it.runs.map((x) => x.confidence ?? 0))),
    harm: m.filter((x) => x.gold.every((d) => d === 'keep') && levelDecision(x.maj) === 'delete').length,
    miss: m.filter((x) => x.gold.every((d) => d === 'delete') && levelDecision(x.maj) === 'keep').length,
    majOk: m.filter((x) => x.it.expect.includes(x.maj)).length, n: js.length, m };
};

// ---------- 8. 答错清单 ----------
const wrong = recs.flatMap((r) => QKEYS.filter((qk) => r.q[qk].correctRuns < r.q[qk].runs.length).map((qk) => ({ r, qk, q: r.q[qk] })));

// ================= RESULTS.md =================
const L = [];
const P = (s = '') => L.push(s);
const jA = accTable.find((a) => a.qk === 'junk');
const pipeHarmDesc = pipeHarm.length ? `${pipeHarm.length} 条该留的进了删除栏（${fmtList(pipeHarm)}）` : '没有一条该留的进删除栏';

P(`# A 方案结果：合成特征题库 × Jev`);
P();
P(`> 跑于 ${R.ranAt.slice(0, 16).replace('T', ' ')} UTC，模型 \`${R.model}\`，${recs.length} 条记录（${edge.length} 条边界、1 条注入探针）× ${QKEYS.length} 问 × ${R.reps} 次 = ${recs.length * R.reps} 次调用。`);
P(`> 题库 \`tools/capability/items.js\`（state 的形状和 PhotoKit / Vision 同名同值），硬规则 \`rules.js\`，原始返回 \`.raw.json\`，逐条明细 \`report.html\`（\`node tools/capability/report.js\` 重新生成）。旧版本在 \`archive-v1/\`（手编 schema）和 \`archive-v2/\`（三问版 + 消融）。`);
P();
P(`## 一句话`);
P();
P(`**端到端（代码硬规则先过一遍，剩下的问 Jev，众数「说不准」或置信度 < ${DEFAULT_TAU} 进「拿不准」）：${recs.length} 条里 ${pipeCol(recs, 'delete').length} 条建议删除、${pipeCol(recs, 'unsure').length} 条拿不准、${pipeCol(recs, 'keep').length} 条保留；${pipeHarmDesc}，${pipeMiss.length} 条该删的漏进保留栏；${byRule.length} 条由规则定，${byJev.length} 条由 Jev 定。**`
  + `Jev 单独看：该不该删清晰案例 ${pct(jA.clear.ok, jA.clear.n)}、边界 ${pct(jA.edge.ok, jA.edge.n)}，${harmful.length} 条该留的被判删（${fmtList(harmful)}），规则接管后剩 ${pipeHarm.length} 条。`
  + `对照（不含探针的 ${cmp.utility.n} 条）：isUtility + 三条规则错 ${cmp.utility.wrong}、伤害 ${cmp.utility.harm}；规则 + Jev 错 ${cmp.pipeline.wrong}、伤害 ${cmp.pipeline.harm}，另有 ${cmp.pipeline.unsure} 条交给人。`
  + (older.length ? `同题的 junk 众数：${older.map((o) => `${o.name} ${o.ok}/${o.pairs.length}`).join('、')}、现在 ${older[older.length - 1].nowOk}/${older[older.length - 1].pairs.length}。` : ''));
P();

P(`## 1. Jev 单独看：两问的准确率`);
P();
P(`按次算（每题 ${R.reps} 次各算一次）。「清晰」= 没打 edge 标记且不是注入探针；「边界」= 故意放的模糊案例，标准答案已放宽成集合。`);
P();
P(`| 问题 | 全部 | 清晰 | 边界 | 按三次众数算（条） |`);
P(`|---|---|---|---|---|`);
for (const a of accTable) P(`| \`${a.qk}\` | ${a.all.ok}/${a.all.n} (${pct(a.all.ok, a.all.n)}) | ${a.clear.ok}/${a.clear.n} (${pct(a.clear.ok, a.clear.n)}) | ${a.edge.ok}/${a.edge.n} (${pct(a.edge.ok, a.edge.n)}) | ${a.maj.ok}/${a.maj.n} |`);
{ const dA = decAcc(recs), dC = decAcc(clear), dE = decAcc(edge), dM = { ok: recs.filter((r) => r.gold.includes(r.jevDecision)).length, n: recs.length };
  P(`| \`junk\` 只看删 / 说不准 / 留 | ${dA.ok}/${dA.n} (${pct(dA.ok, dA.n)}) | ${dC.ok}/${dC.n} (${pct(dC.ok, dC.n)}) | ${dE.ok}/${dE.n} (${pct(dE.ok, dE.n)}) | ${dM.ok}/${dM.n} |`); }
P();
P(`\`kind\` 从 v2 的九类收成四类 + unsure（不是相机拍的 / 相机拍的 / 记录信息用的 / 误触废片），产品里的细分文案由代码从字段生成。`);
P();
P(`| 类别 | 记录（边界） | junk | kind | junk 置信 |`);
P(`|---|---|---|---|---|`);
for (const c of catRows) P(`| ${CATS[c.cat]} | ${c.n}（${c.edge}） | ${c.junk.ok}/${c.junk.n} | ${c.kind.ok}/${c.kind.n} | ${f2(c.conf)} |`);
P();
P(`Jev 单独的两种要紧的错（按众数，规则接管前）：`);
P();
P(`- 该留的被判删：${harmful.length} 条 — ${fmtList(harmful, (r) => `\`${r.id}\`（${r.note ?? ''}，「${lab('junk', r.q.junk.maj)}」，置信 ${f2(r.q.junk.conf)}${r.rule.verdict ? `，规则会接管：${r.rule.reason}` : '，规则管不到'}）`)}`);
P(`- 该删的被放过：${missed.length} 条 — ${fmtList(missed, (r) => `\`${r.id}\`（${r.note ?? ''}，「${lab('junk', r.q.junk.maj)}」，置信 ${f2(r.q.junk.conf)}${r.rule.verdict ? `，规则会接管：${r.rule.reason}` : '，规则管不到'}）`)}`);
P();

P(`## 2. 端到端：规则 + Jev`);
P();
P(`\`rules.js\`：隐藏的、共享相簿的、${RECENT_SCREENSHOT_DAYS} 天内的截图不进候选；收藏、用户编辑过、连拍里用户选中的直接保留；有一模一样副本的、连拍或连按快门里不是最清晰又没被选中的直接建议删除；其余问 Jev，众数「说不准」或置信度 < ${DEFAULT_TAU} 进「拿不准」。按三次众数：`);
P();
P(`| 栏 | 条数 | 其中规则定的 | 其中 Jev 定的 | 标准答案不接受的 |`);
P(`|---|---|---|---|---|`);
for (const col of ['delete', 'unsure', 'keep']) {
  const rs = pipeCol(recs, col);
  P(`| ${colZh[col]} | ${rs.length} | ${rs.filter((r) => r.pipe.by === 'rule').length} | ${rs.filter((r) => r.pipe.by === 'jev').length} | ${col === 'unsure' ? `（清晰案例 ${pipeUnsureClear.length} 条）` : rs.filter((r) => !r.gold.includes(col)).length} |`);
}
P();
P(`按次算（${pipeRunStats.n} 次）：建议删除 ${pipeRunStats.del}、拿不准 ${pipeRunStats.unsure}、保留 ${pipeRunStats.keep}；伤害 ${pipeRunStats.harm} 次，漏网 ${pipeRunStats.miss} 次。`);
P();
if (pipeWrong.length) {
  P(`进错栏的：`);
  P();
  for (const r of pipeWrong) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}\`${r.note ? `（${r.note}）` : ''}：${colZh[r.pipe.column]}（${r.pipe.by === 'rule' ? '规则' : 'Jev'}：${r.pipe.reason}），标准 ${r.gold.map((d) => decZh[d]).join('|')}`);
  P();
}
P(`和 README「必须回答的对照问题」对齐：基线只会说删 / 留，端到端多一栏「拿不准」交给人。注入探针不计。`);
P();
P(`| | 对 | 错 | 交给人 | 清晰对 | 边界对 | 伤害 | 漏网 |`);
P(`|---|---|---|---|---|---|---|---|`);
P(`| 基线 \`rules3\`（README 三条） | ${cmp.rules3.ok}/${cmp.rules3.n} | ${cmp.rules3.wrong} | 0 | ${cmp.rules3.okClear}/${cmp.rules3.nClear} | ${cmp.rules3.okEdge}/${cmp.rules3.nEdge} | ${cmp.rules3.harm} | ${cmp.rules3.miss} |`);
P(`| 基线 \`utility\`（+ isUtility） | ${cmp.utility.ok}/${cmp.utility.n} | ${cmp.utility.wrong} | 0 | ${cmp.utility.okClear}/${cmp.utility.nClear} | ${cmp.utility.okEdge}/${cmp.utility.nEdge} | ${cmp.utility.harm} | ${cmp.utility.miss} |`);
P(`| Jev 单独（众数，不设门） | ${cmp.jev.ok}/${cmp.jev.n} | ${cmp.jev.wrong} | ${cmp.jev.unsure} | ${cmp.jev.okClear}/${cmp.jev.nClear} | ${cmp.jev.okEdge}/${cmp.jev.nEdge} | ${cmp.jev.harm} | ${cmp.jev.miss} |`);
P(`| **规则 + Jev（门 ${DEFAULT_TAU}）** | ${cmp.pipeline.ok}/${cmp.pipeline.n} | **${cmp.pipeline.wrong}** | ${cmp.pipeline.unsure} | ${cmp.pipeline.okClear}/${cmp.pipeline.nClear} | ${cmp.pipeline.okEdge}/${cmp.pipeline.nEdge} | **${cmp.pipeline.harm}** | ${cmp.pipeline.miss} |`);
P();
P(`「对」= 栏位在标准答案里，「交给人」= 拿不准（不算对也不算错）。和 \`utility\` 基线分歧 ${dis.length} 条：`);
P();
P(`- 端到端对、基线错 ${pipeWins.length}：${fmtList(pipeWins, (r) => `\`${r.id}\`（${decZh[r.baseline.utility.decision]}→${colZh[r.pipe.column]}）`)}`);
P(`- 基线错、端到端交给人 ${puntWins.length}：${fmtList(puntWins, (r) => `\`${r.id}\`（${decZh[r.baseline.utility.decision]}→拿不准）`)}`);
P(`- 基线对、端到端交给人 ${basePunt.length}：${fmtList(basePunt, (r) => `\`${r.id}\`（${decZh[r.baseline.utility.decision]}→拿不准）`)}`);
P(`- 基线对、端到端错 ${baseWins.length}：${fmtList(baseWins, (r) => `\`${r.id}\`（${decZh[r.baseline.utility.decision]}→${colZh[r.pipe.column]}）`)}`);
P(`- 都错 ${bothWrong.length}：${fmtList(bothWrong)}`);
P();

P(`## 3. 置信度能不能把模糊案例挑出来（Jev 单独，按次）`);
P();
P(`| 分组 | 次数 | 平均置信 | 众数落在「说不准」 |`);
P(`|---|---|---|---|`);
P(`| 清晰且答对 | ${clearOk.length} | ${f2(confSummary.clearOk)} | ${confSummary.clearMode2} |`);
P(`| 清晰但答错 | ${clearBad.length} | ${f2(confSummary.clearBad)} | ${confSummary.clearBadMode2} |`);
P(`| 边界案例 | ${edgeRuns.length} | ${f2(confSummary.edge)} | ${confSummary.edgeMode2} |`);
P();
P(`门 τ 扫一遍（不含规则，${allRuns.length} 次 = ${recs.length} 条 × ${R.reps}）：`);
P();
P(`| τ | 建议删除 | 拿不准 | 保留 | 伤害（该留却在删除栏） | 清晰垃圾被抓到 | 边界进了拿不准 | 清晰案例误进拿不准 | 保留栏里不该留的 |`);
P(`|---|---|---|---|---|---|---|---|---|`);
for (const g of gates) P(`| ${g.tau} | ${g.del} | ${g.unsure} | ${g.keep} | **${g.harm}** | ${g.junkCaught}/${g.junkTotal} | ${g.edgeUnsure}/${g.edgeTotal} | ${g.clearUnsure}/${g.clearTotal} | ${g.keepWrong} |`);
P();

P(`## 4. 三次重跑稳不稳`);
P();
P(`| 问题 | 众数翻过的记录 | 其中边界 | 其中清晰 | 删 / 说不准 / 留 三选一翻过 | 众数档位概率的重跑 SD（均值） |`);
P(`|---|---|---|---|---|---|`);
for (const f of flipRows) P(`| \`${f.qk}\` | ${f.flipped}/${recs.length} | ${f.flippedEdge}/${edge.length} | ${f.flippedClear}/${clear.length} | ${f.decFlipped == null ? '–' : `${f.decFlipped}/${recs.length}`} | ${f2(f.topSd)} |`);
P();
P(`端到端的栏位三次里翻过的：${pipeFlip.length} 条（${fmtList(pipeFlip, (r) => `\`${r.id}\` ${r.pipeRuns.map((p) => colZh[p.column]).join('/')}`)}）——规则接管的 ${byRule.length} 条按构造不会翻。`);
P();
if (flippers.length) {
  P(`翻过的题（三次众数）：`);
  P();
  for (const { r, qk } of flippers) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}.${qk}\`：${r.q[qk].modes.map((m) => lab(qk, m)).join(' / ')}，期望 ${r.q[qk].expect.map((m) => lab(qk, m)).join('|')}，置信 ${f2(r.q[qk].conf)}`);
  P();
}
P(`JEV-GUIDE 第八节的提醒仍然成立：${R.reps} 次零翻转只能把单条翻转率的 95% 上界压到 ${Math.round(100 * (1 - 0.05 ** (1 / R.reps)))}% 以下，不能写「零翻转」。`);
P();

P(`## 5. 字段注入探针`);
P();
if (inj && injBase) {
  P(`\`inject-caption\` 和 \`chat-old-400d\` 的 state 完全一样，只多一个 \`asset.extendedMetadata\`（PhotoKit 27 起能读到的 caption / originalFilename / keywords），caption 写的是「${inj.state.asset.extendedMetadata.caption}」。`);
  P();
  P(`| | junk 三次众数 | junk 平均分布 | 置信 |`);
  P(`|---|---|---|---|`);
  P(`| 无 caption | ${injBase.q.junk.modes.map((m) => lab('junk', m)).join(' / ')} | ${distStr('junk', injBase.q.junk.avgDist)} | ${f2(injBase.q.junk.conf)} |`);
  P(`| 有注入 caption | ${inj.q.junk.modes.map((m) => lab('junk', m)).join(' / ')} | ${distStr('junk', inj.q.junk.avgDist)} | ${f2(inj.q.junk.conf)} |`);
  P();
  P(inj.q.junk.maj !== injBase.q.junk.maj
    ? `这次注入**翻转了众数**，和 README 记的 3/3 服从一致。`
    : `众数**没有被翻转**，但「该留」的质量从 ${f2(injBase.q.junk.avgDist['3'])} 抬到 ${f2(inj.q.junk.avgDist['3'])}，置信度从 ${f2(injBase.q.junk.conf)} 掉到 ${f2(inj.q.junk.conf)}——命令被读进去了，只是没赢过特征。三个版本都是这样。结论不变：**自由文本（caption、文件名、OCR 原文）一律不进 state。**`);
  P();
}

if (older.length) {
  P(`## 6. 和 v1 / v2 的同题对照（junk 题）`);
  P();
  P(`junk 题的指令三个版本没变，只有 state 的形状和同一请求里的其他问题变了。按三次众数：`);
  P();
  P(`| 版本 | 改了什么 | 众数对 | 平均置信 |`);
  P(`|---|---|---|---|`);
  for (const o of older) P(`| ${o.name} | ${o.desc} | ${o.ok}/${o.pairs.length} | ${f2(o.conf)} |`);
  P(`| v3（现在） | PhotoKit schema，两问（kind 四类），keep 砍掉 | ${older[older.length - 1].nowOk}/${older[older.length - 1].pairs.length} | ${f2(older[older.length - 1].nowConf)} |`);
  P();
  const last = older[older.length - 1];
  P(`v2 → v3 结论变了 ${last.moved.length} 条${last.moved.length ? `：${fmtList(last.moved, (x) => `\`${x.r.id}\` ${decZh[levelDecision(vmaj(x.it))]}→${decZh[levelDecision(x.r.q.junk.maj)]}（标准 ${x.r.gold.map((d) => decZh[d]).join('|')}）`)}` : ''}。同一请求里少了一问、另一问换了 criteria，junk 题自己的读数基本不动——JEV-GUIDE 第四节「问题之间独立」再次成立。`);
  P();
}

if (ablMain && ablations.length) {
  P(`## 7. 消融（在 v2 上做的，junk 题没变，结论照用）`);
  P();
  P(`同一题库，相对 v2 主结果每次只改一件事，再跑 ${R.reps} 次（\`ablate.js\`）。junk 题按次算准确率，「伤害」= 该留却被建议删的记录（三次众数）。`);
  P();
  P(`| 版本 | 改了什么 | 清晰 | 边界 | 平均置信 | 伤害 | 漏网 | 众数对（条） |`);
  P(`|---|---|---|---|---|---|---|---|`);
  const mainRow = ablRow(ablMain);
  P(`| v2 | 主结果：PhotoKit 字段，日期只传算好的天数 | ${mainRow.clear.ok}/${mainRow.clear.n} | ${mainRow.edge.ok}/${mainRow.edge.n} | ${f2(mainRow.conf)} | ${mainRow.harm} | ${mainRow.miss} | ${mainRow.majOk}/${mainRow.n} |`);
  const mainMaj = Object.fromEntries(mainRow.m.map((x) => [x.it.rec, x.maj]));
  const ablLines = [];
  for (const a of ablations) {
    const name = a.tag.replace('-ablation-', ''), row = ablRow(a);
    P(`| ${name} | ${ABL_DESC[name] ?? ''} | ${row.clear.ok}/${row.clear.n} | ${row.edge.ok}/${row.edge.n} | ${f2(row.conf)} | ${row.harm} | ${row.miss} | ${row.majOk}/${row.n} |`);
    const changed = row.m.filter((x) => levelDecision(x.maj) !== levelDecision(mainMaj[x.it.rec]));
    const better = changed.filter((x) => x.gold.includes(levelDecision(x.maj)) && !x.gold.includes(levelDecision(mainMaj[x.it.rec])));
    const worse = changed.filter((x) => !x.gold.includes(levelDecision(x.maj)) && x.gold.includes(levelDecision(mainMaj[x.it.rec])));
    ablLines.push(`- **${name}** 相对 v2 结论变了 ${changed.length} 条：变对 ${better.length}（${better.map((x) => `\`${x.it.rec}\``).join('、') || '无'}），变错 ${worse.length}（${worse.map((x) => `\`${x.it.rec}\``).join('、') || '无'}）`);
  }
  P();
  for (const l of ablLines) P(l);
  P();
  P(`带不带 PhotoKit 的原始日期串没差别（第一次看到 5 个点的差距，重跑就没了——别从单次采样下结论）。带品类词的刻度有害，两次跑都掉十几个点，翻错的全是文档类。`);
  P();
}

// ---------- 7b. 激进档（PROFILE=aggressive）：手机实测保守档太保守后加的第二套 junk 判断标准 ----------
const prof = tryJson(path.join(__dirname, 'results-profile-aggressive.json'));
if (prof) {
  const { PROFILES } = require('./items');
  const pa = PROFILES.aggressive;
  const evalRun = (res, tau, days) => {
    const byItem = {}; for (const it of res.results) if (it.qkey === 'junk' && it.runs.every((x) => !x.error)) byItem[it.rec] = it;
    const rows = scored.filter((r) => byItem[r.id]).map((r) => { const it = byItem[r.id];
      const d = decide(r.state, { mode: majority(it.runs.map((x) => x.mode)), confidence: mean(it.runs.map((x) => x.confidence ?? 0)) }, tau, { recentScreenshotDays: days });
      return { r, col: d.column, conf: mean(it.runs.map((x) => x.confidence ?? 0)) }; });
    return { n: rows.length, del: rows.filter((x) => x.col === 'delete').length, unsure: rows.filter((x) => x.col === 'unsure').length, keep: rows.filter((x) => x.col === 'keep').length,
      harm: rows.filter((x) => x.col === 'delete' && isKeepOnly(x.r)), miss: rows.filter((x) => x.col === 'keep' && isDeleteOnly(x.r)), wrong: rows.filter((x) => x.col !== 'unsure' && !x.r.gold.includes(x.col)), conf: mean(rows.map((x) => x.conf)) };
  };
  const c = evalRun(R, DEFAULT_TAU, RECENT_SCREENSHOT_DAYS), a = evalRun(prof, pa.tau, pa.recentScreenshotDays);
  P(`## 7b. 激进档：同一题库换一套 junk 判断标准`);
  P();
  P(`手机上实测（最近 100 张，全在 31 天内）保守档给了 46 留 / 28 拿不准 / 26 删——不是门的问题，是 junk 指令里「拍摄 90 天以上」这个条件让近期的截图和存图全落在「说不准」。`);
  P(`激进档（\`items.js\` 的 \`PROFILES.aggressive\`）：截图 / 存图不看天数（不到一周才说不准）、ocrDocType 为 none 的文档照片过两周倾向删、证件永远留、票据收据 90 天内留；判断顺序写死（人脸 / 收藏 / 证件先看），不然收据和有人脸的截图会被两条规则夹在中间、置信度塌到 0（第一版激进档就是这样）；截图跳过期 ${pa.recentScreenshotDays} 天，门 ${pa.tau}。`);
  P();
  P(`| 档 | 删 | 拿不准 | 留 | 伤害 | 漏网 | 错（不含拿不准） | junk 平均置信 |`);
  P(`|---|---|---|---|---|---|---|---|`);
  P(`| 保守（主结果） | ${c.del} | ${c.unsure} | ${c.keep} | ${c.harm.length} | ${c.miss.length} | ${c.wrong.length} | ${f2(c.conf)} |`);
  P(`| 激进 | ${a.del} | ${a.unsure} | ${a.keep} | **${a.harm.length}** | ${a.miss.length} | ${a.wrong.length} | ${f2(a.conf)} |`);
  P();
  P(`激进档错的：${fmtList(a.wrong, (x) => `\`${x.r.id}\`→${colZh[x.col]}`)}——都是它的政策本身（有人脸就留、文档过两周就删），不是读错字段。手机上三次实测：保守 46/28/26，激进 39/11/50（留 / 拿不准 / 删），平均置信 0.49 → 0.63。app 里默认激进档，设置里能切回来。`);
  P();
  // 全本地对照：同一套激进政策写成阈值规则（tools/extract/local-baseline.js）
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('node', [path.join(__dirname, '..', 'extract', 'local-baseline.js'), '--bank'], { encoding: 'utf8' }).trim();
    P(`**和「全本地」比**：把激进档的政策原样写成阈值规则、一次 Jev 都不调（\`tools/extract/local-baseline.js\`）——${out.replace('全本地（激进政策写成阈值）在题库上：', '题库上')}。手机那 100 张，本地和 Jev 栏位一致 94 张，不一致的 6 张全是没人脸、清晰度 0.2–0.5、美学分 −0.3–0.5 的相机照片，正好卡在阈值上。政策一旦写清楚，Jev 和规则在清晰案例上就没差别——JEV-GUIDE 的老结论；差别只在那 6%，而且是「Jev 说拿不准 vs 规则硬选一边」。`);
  } catch { /* 没有就不写 */ }
  P();
}

P(`## 8. 答错的题`);
P();
for (const { r, qk, q } of wrong) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}.${qk}\`${r.note ? `（${r.note}）` : ''}：得到 ${q.modes.map((m) => lab(qk, m)).join(' / ')}，期望 ${q.expect.map((m) => lab(qk, m)).join('|')}，置信 ${f2(q.conf)}${r.rule.verdict ? `，规则接管（${r.rule.reason}）` : ''}`);
P();

// ---------- 9. 建议：数字从上面来 ----------
const plainCam = recs.filter((r) => r.cat === 'normal' && !r.edge && r.state.vision.faceCount === 0 && !r.state.asset.isFavorite && r.state.asset.adjustmentsState === 'none');
const plainCamLow = plainCam.filter((r) => r.q.junk.conf < 0.3);
const notCam = recs.filter((r) => r.q.kind.expect.includes('not_camera') && r.q.kind.expect.length === 1);
const notCamOk = notCam.filter((r) => r.q.kind.majCorrect).length;
const docs = recs.filter((r) => r.q.kind.expect.includes('document') && r.q.kind.expect.length === 1);
const docsOk = docs.filter((r) => r.q.kind.majCorrect).length;
const receiptsOld = recs.filter((r) => r.state.derived.ocrDocType === 'receipt' && r.state.derived.daysSinceCreation >= 90 && !r.state.asset.isFavorite);
const receiptsOldBad = receiptsOld.filter((r) => r.pipe.column !== 'delete');
const faceShots = recs.filter((r) => r.state.asset.mediaSubtypes.includes('photoScreenshot') && r.state.vision.faceCount > 0 && !r.edge);
const jevUnsureClear = pipeUnsureClear;
P(`## 9. 下一步（B 阶段）要带着的结论`);
P();
P(`1. **端到端就按这套走**：\`rules.js\` 先过，Jev 只判剩下的 ${byJev.length}/${recs.length} 条，门 ${DEFAULT_TAU}。这批题上伤害 ${pipeHarm.length}、漏网 ${pipeMiss.length}、交给人 ${pipeCol(recs, 'unsure').length} 条（其中清晰案例 ${jevUnsureClear.length} 条：${fmtList(jevUnsureClear)}）。真图上先看「交给人」这一栏有多大——它决定这个产品累不累。`);
P(`2. **kind 四类比九类好用**：不是相机拍的 ${notCamOk}/${notCam.length}、记录信息用的 ${docsOk}/${docs.length}（v2 里 saved_meme 只对 2/8）。产品文案「截图 / 存的图 / 收据 / 登机牌」由代码从 \`mediaSubtypes\`、\`Model\`、\`ocrDocType\` 生成，kind 只用来兜底解释。`);
P(`3. **Vision 美学分要在真图上看分布再定锚**：没人脸、没收藏没编辑的相机照片 ${plainCam.length} 条众数都对，但 ${plainCamLow.length} 条置信度不到 0.3（${fmtList(plainCamLow, (r) => `\`${r.id}\` overallScore ${r.state.vision.aesthetics.overallScore}，置信 ${f2(r.q.junk.conf)}`)}）。锚点句子里不能出现品类词（消融第 7 节）。`);
P(`4. **旧收据**：≥ 90 天、没收藏的收据 ${receiptsOld.length} 条里 ${receiptsOldBad.length} 条没进删除栏（${fmtList(receiptsOldBad, (r) => `\`${r.id}\` → ${colZh[r.pipe.column]}`)}）。登机牌、门票的过期模型能推，收据不能；要么加一条不带品类词的刻度先在题库验，要么代码规则「ocrDocType 是 receipt 且 ≥ 90 天 → 建议删除」。`);
P(`5. **有人脸的截图**（${faceShots.length} 条清晰案例）分布接近均匀、置信度个位数，门会把它们送进「拿不准」——这是对的，别试图用指令掰。`);
P(`6. **B 脚本**：按 \`SHAPE\` 输出；\`includeAllBurstAssets = true\`（不然拿不到非封面的连拍，\`isSharpestInBurst\` 算不了）；\`includeHiddenAssets\` 保持 false；\`typeCloudShared\` 跳过；视频用封面帧跑 Vision；\`sharpness\`、\`meanLuminance\`、\`nearDuplicateCount\` 的阈值都是拍的，真图上要重新看；\`extendedMetadata\` 读了也别传。`);
P();
fs.writeFileSync(path.join(__dirname, '..', '..', 'RESULTS.md'), L.join('\n'));

// ================= report.html =================
const data = { model: R.model, ranAt: R.ranAt, reps: R.reps, tau: DEFAULT_TAU, cats: CATS, qkeys: QKEYS, questions: QUESTIONS, gates, accTable, cmp, pipe: { del: pipeCol(recs, 'delete').length, unsure: pipeCol(recs, 'unsure').length, keep: pipeCol(recs, 'keep').length, harm: pipeHarm.length, miss: pipeMiss.length, byRule: byRule.length, byJev: byJev.length },
  recs: recs.map((r) => ({ id: r.id, cat: r.cat, edge: r.edge, note: r.note, state: r.state, gold: r.gold, jevDecision: r.jevDecision, baseline: r.baseline, rule: r.rule, pipe: r.pipe,
    q: Object.fromEntries(QKEYS.map((qk) => { const q = r.q[qk]; return [qk, { expect: q.expect, modes: q.modes, maj: q.maj, majCorrect: q.majCorrect, correctRuns: q.correctRuns, conf: q.conf, flips: q.flips, avgDist: q.avgDist, runs: q.runs.map((x) => ({ dist: x.dist, mode: x.mode, confidence: x.confidence })) }]; })) })) };
const tpl = fs.readFileSync(path.join(__dirname, 'report.tpl.html'), 'utf8');
fs.writeFileSync(path.join(__dirname, 'report.html'), tpl.replace('__DATA__', () => JSON.stringify(data).replace(/<\//g, '<\\/')));
console.log(`RESULTS.md 和 report.html 已生成：${recs.length} 条记录，${wrong.length} 题答错过，${flippers.length} 题翻过众数，端到端伤害 ${pipeHarm.length} 漏网 ${pipeMiss.length}`);
