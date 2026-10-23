// Turn results.json into RESULTS.md (conclusions) and report.html (per-record detail, filterable).
// Answers phase A's three questions: accuracy, whether confidence picks out ambiguous cases, and stability across reruns —
// plus "what does Jev add over isUtility + rules?", compared end to end as rules + Jev.
//   node tools/capability/report.js
const fs = require('node:fs');
const path = require('node:path');
const { CATS, QKEYS, QUESTIONS, records } = require('./items');
const { BASELINES, levelDecision, goldDecisions } = require('./baseline');
const { applyRules, decide, DEFAULT_TAU, RECENT_SCREENSHOT_DAYS } = require('./rules');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => { try { return readJson(f); } catch { return null; } };
const R = readJson(path.join(__dirname, 'results.json'));
// Were these results measured with the prompts currently in items.js? If not, say so instead of implying they were.
const promptsMatch = QKEYS.every((qk) => R.results.some((it) => it.qkey === qk && it.q && it.q.instructions === QUESTIONS[qk].instructions));
const labelOf = (q, k) => (q.type === 'score' ? q.criteria[Number(k)] : k); // choice questions use the key; the criteria text is too long
const lab = (qk, k) => labelOf(QUESTIONS[qk], k);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const majority = (modes) => { const c = {}; for (const m of modes) c[m] = (c[m] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
const decName = { delete: 'delete', unsure: 'not sure', keep: 'keep' };
const colName = { delete: 'Suggest delete', unsure: 'Not sure', keep: 'Keep' };
const fmtList = (rs, f = (r) => `\`${r.id}\``) => rs.map(f).join(', ') || 'none';

// ---------- per record ----------
const items = R.results.filter((it) => it.runs.every((x) => !x.error));
const byRec = {};
const noteOf = Object.fromEntries(records.map((r) => [r.id, r.note]));
const stateOf = Object.fromEntries(records.map((r) => [r.id, r.state]));
for (const it of items) {
  // notes and states come from the current bank, not the results file, so editing a note never needs a rerun
  const rec = (byRec[it.rec] ??= { id: it.rec, cat: it.cat, edge: it.edge, note: noteOf[it.rec] ?? it.note, state: stateOf[it.rec] ?? it.state, q: {} });
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
  // end to end: per run (one call = one run in the product) and by majority of the runs
  r.pipeRuns = j.runs.map((x) => decide(r.state, { mode: x.mode, confidence: x.confidence }, DEFAULT_TAU));
  r.pipe = decide(r.state, { mode: j.maj, confidence: j.conf }, DEFAULT_TAU);
}
const clear = recs.filter((r) => !r.edge && r.cat !== 'robust');
const edge = recs.filter((r) => r.edge);
const isKeepOnly = (r) => r.gold.every((d) => d === 'keep');
const isDeleteOnly = (r) => r.gold.every((d) => d === 'delete');

// ---------- 1. Jev alone ----------
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

// ---------- 2. end to end: rules + Jev ----------
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
// Comparison: baselines (delete / keep only), Jev alone (majority), rules + Jev
const scored = recs.filter((r) => r.cat !== 'robust');
// "correct" = the column is in the answer key; "not sure" is handed to a human and counted separately
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

// ---------- 3. confidence gate (Jev alone, per run) ----------
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

// ---------- 4. stability ----------
const decFlip = (r) => new Set(r.q.junk.modes.map(levelDecision)).size > 1;
const flipRows = QKEYS.map((qk) => ({ qk,
  flipped: recs.filter((r) => r.q[qk].flips > 0).length, flippedEdge: edge.filter((r) => r.q[qk].flips > 0).length, flippedClear: clear.filter((r) => r.q[qk].flips > 0).length,
  decFlipped: qk === 'junk' ? recs.filter(decFlip).length : null, topSd: mean(recs.map((r) => r.q[qk].topSd)) }));
const flippers = recs.flatMap((r) => QKEYS.filter((qk) => r.q[qk].flips > 0).map((qk) => ({ r, qk })));
const pipeFlip = recs.filter((r) => new Set(r.pipeRuns.map((p) => p.column)).size > 1);

// ---------- 5. injection ----------
const inj = byRec['inject-caption'], injBase = byRec['chat-old-400d'];
const distStr = (qk, d) => Object.entries(d).filter(([, p]) => p >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${lab(qk, k)} ${p.toFixed(2)}`).join(' / ');

// ---------- 6. ablations (relative to the main result in this directory) ----------
const ablations = fs.readdirSync(__dirname).filter((f) => /^results-ablation-.*\.json$/.test(f)).map((f) => readJson(path.join(__dirname, f)));
let ABL_DESC = {};
try { ABL_DESC = Object.fromEntries(Object.entries(require('./ablate').ABLATIONS).map(([k, v]) => [k, v.desc])); } catch { /* descriptions are optional */ }
const ablRow = (res) => {
  const js = res.results.filter((it) => it.qkey === 'junk' && it.runs.every((x) => !x.error));
  const acc = (rs) => { let ok = 0, n = 0; for (const it of rs) for (const x of it.runs) { n++; if (x.correct) ok++; } return { ok, n }; };
  const m = js.map((it) => ({ it, maj: majority(it.runs.map((x) => x.mode)), gold: goldDecisions(it.expect) }));
  return { clear: acc(js.filter((it) => !it.edge && it.cat !== 'robust')), edge: acc(js.filter((it) => it.edge)), conf: mean(js.flatMap((it) => it.runs.map((x) => x.confidence ?? 0))),
    harm: m.filter((x) => x.gold.every((d) => d === 'keep') && levelDecision(x.maj) === 'delete').length,
    miss: m.filter((x) => x.gold.every((d) => d === 'delete') && levelDecision(x.maj) === 'keep').length,
    majOk: m.filter((x) => x.it.expect.includes(x.maj)).length, n: js.length, m };
};

// ---------- 8. wrong answers ----------
const wrong = recs.flatMap((r) => QKEYS.filter((qk) => r.q[qk].correctRuns < r.q[qk].runs.length).map((qk) => ({ r, qk, q: r.q[qk] })));

// ================= RESULTS.md =================
const L = [];
const P = (s = '') => L.push(s);
const jA = accTable.find((a) => a.qk === 'junk');
const pipeHarmDesc = pipeHarm.length ? `${pipeHarm.length} keepers landed in the delete column (${fmtList(pipeHarm)})` : 'no keeper landed in the delete column';

P(`# Phase A results: synthetic feature bank × Jev`);
P();
P(`> Run at ${R.ranAt.slice(0, 16).replace('T', ' ')} UTC, model \`${R.model}\`, ${recs.length} records (${edge.length} borderline, 1 injection probe) × ${QKEYS.length} questions × ${R.reps} runs = ${recs.length * R.reps} calls.`);
if (!promptsMatch) P(`> **These numbers were measured with an earlier, Chinese-language version of the question text.** The bank's records, states and answer key are unchanged, but the questions in \`items.js\` have since been translated to English and not rerun. Run \`node tools/capability/run.js\` to measure the current prompts.`);
P(`> Bank: \`tools/capability/items.js\` (state fields named and valued exactly as in PhotoKit / Vision); hard rules: \`rules.js\`; raw responses: \`.raw.json\`; per-record detail: \`report.html\`. Regenerate with \`node tools/capability/report.js\`.`);
P();
P(`## Summary`);
P();
P(`**End to end (hard rules first, the rest to Jev; a "not sure" majority or confidence < ${DEFAULT_TAU} goes to "Not sure"): of ${recs.length} records, ${pipeCol(recs, 'delete').length} suggest delete, ${pipeCol(recs, 'unsure').length} not sure, ${pipeCol(recs, 'keep').length} keep; ${pipeHarmDesc}; ${pipeMiss.length} junk record${pipeMiss.length === 1 ? '' : 's'} landed in Keep; ${byRule.length} decided by rules, ${byJev.length} by Jev.** `
  + `Jev alone: junk question ${pct(jA.clear.ok, jA.clear.n)} on clear cases, ${pct(jA.edge.ok, jA.edge.n)} on borderline ones; ${harmful.length} keepers were judged delete (${fmtList(harmful)}), ${pipeHarm.length} after the rules take over. `
  + `Comparison (${cmp.utility.n} records, probe excluded): isUtility + three rules — ${cmp.utility.wrong} wrong, ${cmp.utility.harm} harmful; rules + Jev — ${cmp.pipeline.wrong} wrong, ${cmp.pipeline.harm} harmful, plus ${cmp.pipeline.unsure} handed to a human.`);
P();

P(`## 1. Jev alone: accuracy of both questions`);
P();
P(`Counted per run (each of the ${R.reps} runs scored separately). "Clear" = not flagged borderline and not the injection probe; "borderline" = deliberately ambiguous cases whose answer key accepts a set.`);
P();
P(`| Question | All | Clear | Borderline | By majority of runs (records) |`);
P(`|---|---|---|---|---|`);
for (const a of accTable) P(`| \`${a.qk}\` | ${a.all.ok}/${a.all.n} (${pct(a.all.ok, a.all.n)}) | ${a.clear.ok}/${a.clear.n} (${pct(a.clear.ok, a.clear.n)}) | ${a.edge.ok}/${a.edge.n} (${pct(a.edge.ok, a.edge.n)}) | ${a.maj.ok}/${a.maj.n} |`);
{ const dA = decAcc(recs), dC = decAcc(clear), dE = decAcc(edge), dM = { ok: recs.filter((r) => r.gold.includes(r.jevDecision)).length, n: recs.length };
  P(`| \`junk\` as delete / not sure / keep only | ${dA.ok}/${dA.n} (${pct(dA.ok, dA.n)}) | ${dC.ok}/${dC.n} (${pct(dC.ok, dC.n)}) | ${dE.ok}/${dE.n} (${pct(dE.ok, dE.n)}) | ${dM.ok}/${dM.n} |`); }
P();
P(`\`kind\` has four classes + unsure (not taken by a camera / camera photo / records information / accidental reject); finer product labels are generated in code from the fields.`);
P();
P(`| Category | Records (borderline) | junk | kind | junk confidence |`);
P(`|---|---|---|---|---|`);
for (const c of catRows) P(`| ${CATS[c.cat]} | ${c.n} (${c.edge}) | ${c.junk.ok}/${c.junk.n} | ${c.kind.ok}/${c.kind.n} | ${f2(c.conf)} |`);
P();
P(`The two errors that matter for Jev alone (by majority, before the rules take over):`);
P();
P(`- Keepers judged delete: ${harmful.length} — ${fmtList(harmful, (r) => `\`${r.id}\` (${r.note ?? ''}; "${lab('junk', r.q.junk.maj)}", confidence ${f2(r.q.junk.conf)}${r.rule.verdict ? `; the rules take over: ${r.rule.reason}` : '; no rule covers it'})`)}`);
P(`- Junk let through: ${missed.length} — ${fmtList(missed, (r) => `\`${r.id}\` (${r.note ?? ''}; "${lab('junk', r.q.junk.maj)}", confidence ${f2(r.q.junk.conf)}${r.rule.verdict ? `; the rules take over: ${r.rule.reason}` : '; no rule covers it'})`)}`);
P();

P(`## 2. End to end: rules + Jev`);
P();
P(`\`rules.js\`: hidden, shared-album, and screenshots from the last ${RECENT_SCREENSHOT_DAYS} days are not candidates; favorited, user-edited and user-picked burst frames are kept; images with an identical copy and non-sharpest, unpicked burst / rapid-fire frames are suggested for deletion; everything else goes to Jev, and a "not sure" majority or confidence < ${DEFAULT_TAU} goes to "Not sure". By majority of runs:`);
P();
P(`| Column | Records | Decided by rules | Decided by Jev | Not accepted by the answer key |`);
P(`|---|---|---|---|---|`);
for (const col of ['delete', 'unsure', 'keep']) {
  const rs = pipeCol(recs, col);
  P(`| ${colName[col]} | ${rs.length} | ${rs.filter((r) => r.pipe.by === 'rule').length} | ${rs.filter((r) => r.pipe.by === 'jev').length} | ${col === 'unsure' ? `(clear cases: ${pipeUnsureClear.length})` : rs.filter((r) => !r.gold.includes(col)).length} |`);
}
P();
P(`Per run (${pipeRunStats.n} runs): suggest delete ${pipeRunStats.del}, not sure ${pipeRunStats.unsure}, keep ${pipeRunStats.keep}; harmful ${pipeRunStats.harm}, missed ${pipeRunStats.miss}.`);
P();
if (pipeWrong.length) {
  P(`Records in the wrong column:`);
  P();
  for (const r of pipeWrong) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}\`${r.note ? ` (${r.note})` : ''}: ${colName[r.pipe.column]} (${r.pipe.by === 'rule' ? 'rule' : 'Jev'}: ${r.pipe.reason}), expected ${r.gold.map((d) => decName[d]).join('|')}`);
  P();
}
P(`Against the rules-only baselines: the baselines can only say delete / keep; the pipeline has an extra "Not sure" column handed to a human. The injection probe is excluded.`);
P();
P(`| | Correct | Wrong | To a human | Clear correct | Borderline correct | Harmful | Missed |`);
P(`|---|---|---|---|---|---|---|---|`);
P(`| Baseline \`rules3\` (three rules) | ${cmp.rules3.ok}/${cmp.rules3.n} | ${cmp.rules3.wrong} | 0 | ${cmp.rules3.okClear}/${cmp.rules3.nClear} | ${cmp.rules3.okEdge}/${cmp.rules3.nEdge} | ${cmp.rules3.harm} | ${cmp.rules3.miss} |`);
P(`| Baseline \`utility\` (+ isUtility) | ${cmp.utility.ok}/${cmp.utility.n} | ${cmp.utility.wrong} | 0 | ${cmp.utility.okClear}/${cmp.utility.nClear} | ${cmp.utility.okEdge}/${cmp.utility.nEdge} | ${cmp.utility.harm} | ${cmp.utility.miss} |`);
P(`| Jev alone (majority, no gate) | ${cmp.jev.ok}/${cmp.jev.n} | ${cmp.jev.wrong} | ${cmp.jev.unsure} | ${cmp.jev.okClear}/${cmp.jev.nClear} | ${cmp.jev.okEdge}/${cmp.jev.nEdge} | ${cmp.jev.harm} | ${cmp.jev.miss} |`);
P(`| **Rules + Jev (gate ${DEFAULT_TAU})** | ${cmp.pipeline.ok}/${cmp.pipeline.n} | **${cmp.pipeline.wrong}** | ${cmp.pipeline.unsure} | ${cmp.pipeline.okClear}/${cmp.pipeline.nClear} | ${cmp.pipeline.okEdge}/${cmp.pipeline.nEdge} | **${cmp.pipeline.harm}** | ${cmp.pipeline.miss} |`);
P();
P(`"Correct" = the column is in the answer key; "to a human" = Not sure (neither correct nor wrong). ${dis.length} records where the pipeline and the \`utility\` baseline disagree:`);
P();
P(`- Pipeline right, baseline wrong: ${pipeWins.length} — ${fmtList(pipeWins, (r) => `\`${r.id}\` (${decName[r.baseline.utility.decision]} → ${colName[r.pipe.column]})`)}`);
P(`- Baseline wrong, pipeline hands to a human: ${puntWins.length} — ${fmtList(puntWins, (r) => `\`${r.id}\` (${decName[r.baseline.utility.decision]} → Not sure)`)}`);
P(`- Baseline right, pipeline hands to a human: ${basePunt.length} — ${fmtList(basePunt, (r) => `\`${r.id}\` (${decName[r.baseline.utility.decision]} → Not sure)`)}`);
P(`- Baseline right, pipeline wrong: ${baseWins.length} — ${fmtList(baseWins, (r) => `\`${r.id}\` (${decName[r.baseline.utility.decision]} → ${colName[r.pipe.column]})`)}`);
P(`- Both wrong: ${bothWrong.length} — ${fmtList(bothWrong)}`);
P();

P(`## 3. Can confidence pick out the ambiguous cases? (Jev alone, per run)`);
P();
P(`| Group | Runs | Mean confidence | Mode on "not sure" |`);
P(`|---|---|---|---|`);
P(`| Clear and correct | ${clearOk.length} | ${f2(confSummary.clearOk)} | ${confSummary.clearMode2} |`);
P(`| Clear but wrong | ${clearBad.length} | ${f2(confSummary.clearBad)} | ${confSummary.clearBadMode2} |`);
P(`| Borderline | ${edgeRuns.length} | ${f2(confSummary.edge)} | ${confSummary.edgeMode2} |`);
P();
P(`Sweeping the gate τ (no rules, ${allRuns.length} runs = ${recs.length} records × ${R.reps}):`);
P();
P(`| τ | Suggest delete | Not sure | Keep | Harmful (keeper in delete) | Clear junk caught | Borderline sent to Not sure | Clear cases sent to Not sure | Non-keepers in Keep |`);
P(`|---|---|---|---|---|---|---|---|---|`);
for (const g of gates) P(`| ${g.tau} | ${g.del} | ${g.unsure} | ${g.keep} | **${g.harm}** | ${g.junkCaught}/${g.junkTotal} | ${g.edgeUnsure}/${g.edgeTotal} | ${g.clearUnsure}/${g.clearTotal} | ${g.keepWrong} |`);
P();

P(`## 4. Stability across ${R.reps} runs`);
P();
P(`| Question | Records whose mode flipped | Borderline | Clear | delete / not sure / keep flipped | Rerun SD of the modal level's probability (mean) |`);
P(`|---|---|---|---|---|---|`);
for (const f of flipRows) P(`| \`${f.qk}\` | ${f.flipped}/${recs.length} | ${f.flippedEdge}/${edge.length} | ${f.flippedClear}/${clear.length} | ${f.decFlipped == null ? '–' : `${f.decFlipped}/${recs.length}`} | ${f2(f.topSd)} |`);
P();
P(`End-to-end column changed between runs: ${pipeFlip.length} records (${fmtList(pipeFlip, (r) => `\`${r.id}\` ${r.pipeRuns.map((p) => colName[p.column]).join(' / ')}`)}). The ${byRule.length} records decided by rules cannot flip by construction.`);
P();
if (flippers.length) {
  P(`Items whose mode flipped:`);
  P();
  for (const { r, qk } of flippers) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}.${qk}\`: ${r.q[qk].modes.map((m) => lab(qk, m)).join(' / ')}, expected ${r.q[qk].expect.map((m) => lab(qk, m)).join('|')}, confidence ${f2(r.q[qk].conf)}`);
  P();
}
P(`Zero flips in ${R.reps} runs only bounds a record's flip rate below ${Math.round(100 * (1 - 0.05 ** (1 / R.reps)))}% at 95% confidence — never write "never flips" from a handful of reruns.`);
P();

P(`## 5. Field injection probe`);
P();
if (inj && injBase) {
  P(`\`inject-caption\` has exactly the same state as \`chat-old-400d\` plus an \`asset.extendedMetadata\` block (caption / originalFilename / keywords, readable from PhotoKit 27). The caption says: "${inj.state.asset.extendedMetadata.caption}"`);
  P();
  P(`| | junk mode per run | mean junk distribution | confidence |`);
  P(`|---|---|---|---|`);
  P(`| no caption | ${injBase.q.junk.modes.map((m) => lab('junk', m)).join(' / ')} | ${distStr('junk', injBase.q.junk.avgDist)} | ${f2(injBase.q.junk.conf)} |`);
  P(`| injected caption | ${inj.q.junk.modes.map((m) => lab('junk', m)).join(' / ')} | ${distStr('junk', inj.q.junk.avgDist)} | ${f2(inj.q.junk.conf)} |`);
  P();
  const keepBefore = injBase.q.junk.avgDist['3'], keepAfter = inj.q.junk.avgDist['3'];
  P(inj.q.junk.maj !== injBase.q.junk.maj
    ? `The injection **flipped the majority answer**. Free text (captions, file names, OCR text) must never go into the state.`
    : `The majority answer **did not flip**; the mass on "keep" went from ${f2(keepBefore)} to ${f2(keepAfter)} and confidence from ${f2(injBase.q.junk.conf)} to ${f2(inj.q.junk.conf)}. ${keepAfter > keepBefore + 0.05 ? 'The command was read, it just did not outweigh the features. ' : ''}Either way: free text (captions, file names, OCR text) never goes into the state.`);
  P();
}

if (ablations.length) {
  const mainRow = ablRow(R);
  P(`## 6. Ablations`);
  P();
  P(`Same bank, change exactly one thing relative to the main result, ${R.reps} runs each (\`ablate.js\`). junk accuracy is per run; "harmful" = keepers suggested for deletion (by majority).`);
  P();
  P(`| Version | What changed | Clear | Borderline | Mean confidence | Harmful | Missed | Majority correct (records) |`);
  P(`|---|---|---|---|---|---|---|---|`);
  P(`| main | PhotoKit fields, dates sent only as computed day counts | ${mainRow.clear.ok}/${mainRow.clear.n} | ${mainRow.edge.ok}/${mainRow.edge.n} | ${f2(mainRow.conf)} | ${mainRow.harm} | ${mainRow.miss} | ${mainRow.majOk}/${mainRow.n} |`);
  const mainMaj = Object.fromEntries(mainRow.m.map((x) => [x.it.rec, x.maj]));
  const ablLines = [];
  for (const a of ablations) {
    const name = a.tag.replace('-ablation-', ''), row = ablRow(a);
    P(`| ${name} | ${ABL_DESC[name] ?? ''} | ${row.clear.ok}/${row.clear.n} | ${row.edge.ok}/${row.edge.n} | ${f2(row.conf)} | ${row.harm} | ${row.miss} | ${row.majOk}/${row.n} |`);
    const changed = row.m.filter((x) => levelDecision(x.maj) !== levelDecision(mainMaj[x.it.rec]));
    const better = changed.filter((x) => x.gold.includes(levelDecision(x.maj)) && !x.gold.includes(levelDecision(mainMaj[x.it.rec])));
    const worse = changed.filter((x) => !x.gold.includes(levelDecision(x.maj)) && x.gold.includes(levelDecision(mainMaj[x.it.rec])));
    const dClear = row.clear.ok / row.clear.n - mainRow.clear.ok / mainRow.clear.n;
    ablLines.push(`- **${name}**: clear-case accuracy ${dClear >= 0 ? '+' : ''}${Math.round(100 * dClear)} points; decision changed on ${changed.length} records — ${better.length} became correct (${better.map((x) => `\`${x.it.rec}\``).join(', ') || 'none'}), ${worse.length} became wrong (${worse.map((x) => `\`${x.it.rec}\``).join(', ') || 'none'}).`);
  }
  P();
  for (const l of ablLines) P(l);
  P();
  P(`A difference of a few points between single runs of ${R.reps} is within rerun noise; only a consistent shift across reruns means anything.`);
  P();
}

// ---------- 6b. aggressive profile (PROFILE=aggressive): a second set of junk criteria ----------
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
  P(`## 7. Aggressive profile: same bank, different junk criteria`);
  P();
  P(`Why it exists: on a phone (the latest 100 photos, all within 31 days, measured with the earlier Chinese-language prompts) the conservative profile gave 46 keep / 28 not sure / 26 delete. The cause was not the gate but the "older than 90 days" condition, which sent every recent screenshot and saved image to "not sure".`);
  P(`The aggressive profile (\`PROFILES.aggressive\` in \`items.js\`): screenshots / saved images regardless of age (only those under a week are "not sure"), document photos with ocrDocType none lean delete after two weeks, IDs always kept, receipts / tickets kept within 90 days; the order of checks is fixed (faces / favorites / IDs first), otherwise receipts and screenshots with faces get caught between two rules and confidence collapses. Screenshot skip window ${pa.recentScreenshotDays} days, gate ${pa.tau}.`);
  P();
  P(`| Profile | Delete | Not sure | Keep | Harmful | Missed | Wrong (excl. not sure) | Mean junk confidence |`);
  P(`|---|---|---|---|---|---|---|---|`);
  P(`| conservative (main) | ${c.del} | ${c.unsure} | ${c.keep} | ${c.harm.length} | ${c.miss.length} | ${c.wrong.length} | ${f2(c.conf)} |`);
  P(`| aggressive | ${a.del} | ${a.unsure} | ${a.keep} | **${a.harm.length}** | ${a.miss.length} | ${a.wrong.length} | ${f2(a.conf)} |`);
  P();
  P(`Wrong under the aggressive profile: ${fmtList(a.wrong, (x) => `\`${x.r.id}\` → ${colName[x.col]}`)}.${a.harm.length ? ` Harmful: ${fmtList(a.harm, (x) => `\`${x.r.id}\``)}.` : ''}`);
  P();
  // Fully local comparison: the same aggressive policy written as threshold rules (tools/extract/local-baseline.js)
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('node', [path.join(__dirname, '..', 'extract', 'local-baseline.js'), '--bank'], { encoding: 'utf8' }).trim();
    P(`**Against a fully local version**: the aggressive policy written as plain threshold rules, with no Jev calls (\`tools/extract/local-baseline.js\`) — ${out}`);
  } catch { /* omitted if unavailable */ }
  P();
}

P(`## 8. Wrong answers`);
P();
for (const { r, qk, q } of wrong) P(`- ${r.edge ? '⚑ ' : ''}\`${r.id}.${qk}\`${r.note ? ` (${r.note})` : ''}: got ${q.modes.map((m) => lab(qk, m)).join(' / ')}, expected ${q.expect.map((m) => lab(qk, m)).join('|')}, confidence ${f2(q.conf)}${r.rule.verdict ? `; taken over by rule (${r.rule.reason})` : ''}`);
P();

// ---------- 9. observations computed from the numbers above ----------
const plainCam = recs.filter((r) => r.cat === 'normal' && !r.edge && r.state.vision.faceCount === 0 && !r.state.asset.isFavorite && r.state.asset.adjustmentsState === 'none');
const plainCamLow = plainCam.filter((r) => r.q.junk.conf < 0.3);
const notCam = recs.filter((r) => r.q.kind.expect.includes('not_camera') && r.q.kind.expect.length === 1);
const notCamOk = notCam.filter((r) => r.q.kind.majCorrect).length;
const docs = recs.filter((r) => r.q.kind.expect.includes('document') && r.q.kind.expect.length === 1);
const docsOk = docs.filter((r) => r.q.kind.majCorrect).length;
const receiptsOld = recs.filter((r) => r.state.derived.ocrDocType === 'receipt' && r.state.derived.daysSinceCreation >= 90 && !r.state.asset.isFavorite);
const receiptsOldBad = receiptsOld.filter((r) => r.pipe.column !== 'delete');
const faceShots = recs.filter((r) => r.state.asset.mediaSubtypes.includes('photoScreenshot') && r.state.vision.faceCount > 0 && !r.edge);
P(`## 9. Observations to carry into real photos`);
P();
P(`1. **Pipeline**: \`rules.js\` first, Jev only for the remaining ${byJev.length}/${recs.length} records, gate ${DEFAULT_TAU}. On this bank: ${pipeHarm.length} harmful, ${pipeMiss.length} missed, ${pipeCol(recs, 'unsure').length} handed to a human (${pipeUnsureClear.length} of them clear cases: ${fmtList(pipeUnsureClear)}). On real photos, watch the size of the "Not sure" column — it decides how much work the product leaves to the user.`);
P(`2. **kind with four classes**: not taken by a camera ${notCamOk}/${notCam.length}, records information ${docsOk}/${docs.length}. Product labels ("screenshot / saved image / receipt / boarding pass") come from \`mediaSubtypes\`, \`Model\` and \`ocrDocType\` in code; kind is only a fallback explanation.`);
P(`3. **Vision aesthetics scores need calibrating on real photos**: of ${plainCam.length} plain camera photos (no faces, not favorited or edited), ${plainCamLow.length} have confidence below 0.3${plainCamLow.length ? ` (${fmtList(plainCamLow, (r) => `\`${r.id}\` overallScore ${r.state.vision.aesthetics.overallScore}, confidence ${f2(r.q.junk.conf)}`)})` : ''}. Any anchor sentence for the scale must not contain category words (see the anchors ablation).`);
P(`4. **Old receipts**: ${receiptsOldBad.length} of ${receiptsOld.length} unfavorited receipts ≥ 90 days old did not reach the delete column${receiptsOldBad.length ? ` (${fmtList(receiptsOldBad, (r) => `\`${r.id}\` → ${colName[r.pipe.column]}`)})` : ''}. If that matters, a code rule ("ocrDocType receipt and ≥ 90 days → suggest delete") is more reliable than more instruction text.`);
P(`5. **Screenshots with faces** (${faceShots.length} clear cases): mean junk confidence ${f2(mean(faceShots.map((r) => r.q.junk.conf)))}; whatever the model says, these are genuine conflicts and belong in "Not sure" rather than being forced by instructions.`);
P(`6. **Extractor**: emit \`SHAPE\`; set \`includeAllBurstAssets = true\` (otherwise non-cover burst frames are missing and \`isSharpestInBurst\` can't be computed); keep \`includeHiddenAssets\` false; skip \`typeCloudShared\`; run Vision on the poster frame of videos; the \`sharpness\`, \`meanLuminance\` and \`nearDuplicateCount\` thresholds were guessed and must be rechecked on real photos; read \`extendedMetadata\` but never send it.`);
P();
fs.writeFileSync(path.join(__dirname, '..', '..', 'RESULTS.md'), L.join('\n'));

// ================= report.html =================
const data = { promptsMatch, model: R.model, ranAt: R.ranAt, reps: R.reps, tau: DEFAULT_TAU, cats: CATS, qkeys: QKEYS, questions: QUESTIONS, gates, accTable, cmp, pipe: { del: pipeCol(recs, 'delete').length, unsure: pipeCol(recs, 'unsure').length, keep: pipeCol(recs, 'keep').length, harm: pipeHarm.length, miss: pipeMiss.length, byRule: byRule.length, byJev: byJev.length },
  recs: recs.map((r) => ({ id: r.id, cat: r.cat, edge: r.edge, note: r.note, state: r.state, gold: r.gold, jevDecision: r.jevDecision, baseline: r.baseline, rule: r.rule, pipe: r.pipe,
    q: Object.fromEntries(QKEYS.map((qk) => { const q = r.q[qk]; return [qk, { expect: q.expect, modes: q.modes, maj: q.maj, majCorrect: q.majCorrect, correctRuns: q.correctRuns, conf: q.conf, flips: q.flips, avgDist: q.avgDist, runs: q.runs.map((x) => ({ dist: x.dist, mode: x.mode, confidence: x.confidence })) }]; })) })) };
const tpl = fs.readFileSync(path.join(__dirname, 'report.tpl.html'), 'utf8');
fs.writeFileSync(path.join(__dirname, 'report.html'), tpl.replace('__DATA__', () => JSON.stringify(data).replace(/<\//g, '<\\/')));
console.log(`Wrote RESULTS.md and report.html: ${recs.length} records, ${wrong.length} items wrong at least once, ${flippers.length} items flipped, end-to-end harmful ${pipeHarm.length}, missed ${pipeMiss.length}`);
