// Phase B step two: features.json → rules → (human review of the payload) → Jev → review.html. Nothing is deleted.
//
//   node tools/extract/ask.js out/downloads            # dry run: print each item's rule verdict / features for Jev, write to-send.json and a review.html without Jev
//   node tools/extract/ask.js out/downloads --send     # real run: ask Jev about what the rules don't cover (junk + kind, one call), write decisions.json + review.html
//   TAU=0.3 REPS=1 node tools/extract/ask.js ... --send
// Questions, hard rules and gate are taken directly from phase A: tools/capability/{items,rules,run}.js.
const fs = require('node:fs');
const path = require('node:path');
const { QUESTIONS, QKEYS } = require('../capability/items');
const { applyRules, decide, DEFAULT_TAU } = require('../capability/rules');

const outDir = process.argv[2];
const SEND = process.argv.includes('--send');
if (!outDir) { console.error('Usage: node tools/extract/ask.js <outDir> [--send]   (outDir must contain features.json from tools/extract/extract)'); process.exit(2); }
const TAU = Number(process.env.TAU ?? DEFAULT_TAU);
const REPS = Number(process.env.REPS ?? 1);
const F = JSON.parse(fs.readFileSync(path.join(outDir, 'features.json'), 'utf8'));

// ---------- 1. rules first ----------
const rows = F.records.map((r) => ({ ...r, rule: applyRules(r.state) }));
const toAsk = rows.filter((r) => !r.rule.verdict);
const summ = (s) => {
  const a = s.asset, t = s.imageProperties.TIFF, v = s.vision, d = s.derived;
  return [a.mediaType === 'video' ? `video ${a.duration}s` : null, ...a.mediaSubtypes, `${a.pixelWidth}×${a.pixelHeight}`, t.Model ?? 'no EXIF', `faces ${v.faceCount}`, `chars ${v.recognizedTextCharCount}`,
    v.barcodeCount ? `barcodes ${v.barcodeCount}` : null, d.ocrDocType !== 'none' ? d.ocrDocType : null, v.aesthetics.isUtility ? 'utility' : null, `aesth ${v.aesthetics.overallScore ?? '–'}`, `sharp ${d.sharpness ?? '–'}`, `lum ${d.meanLuminance ?? '–'}`,
    `${d.daysSinceCreation}d`, d.exactDuplicateCount ? `copies ${d.exactDuplicateCount}` : null, d.nearDuplicateCount ? `near-dups ${d.nearDuplicateCount}` : null, d.isSharpestInBurst === false ? 'not sharpest in burst' : null].filter((x) => x != null).join(' · ');
};
console.log(`${F.source} (${F.mode}): ${rows.length} items, ${rows.length - toAsk.length} decided by rules, ${toAsk.length} for Jev × ${QKEYS.length} questions × ${REPS} runs, gate ${TAU}\n`);
for (const r of rows) console.log(`  ${r.id.slice(0, 34).padEnd(34)} ${r.rule.verdict ? `rule ${r.rule.verdict.padEnd(6)} ${r.rule.reason}` : '→ Jev'.padEnd(20)}  ${summ(r.state)}`);

// Dry run: write exactly what would be sent so a human can inspect it (states plus both questions' instructions / criteria)
const toSend = { model: '~typesafe/jev-latest', questions: QUESTIONS, records: toAsk.map((r) => ({ id: r.id, file: r.file, state: r.state })) };
fs.writeFileSync(path.join(outDir, 'to-send.json'), JSON.stringify(toSend, null, 1));
console.log(`\nThe exact payload for Jev is in ${path.join(outDir, 'to-send.json')} (no pixels, no file names, no OCR text; file names stay local for cross-reference).`);

// ---------- 2. ask Jev ----------
async function main() {
  const jev = {}; // id -> { junk: [read...], kind: [read...] }
  if (SEND && toAsk.length) {
    const { callMany, read } = require('../capability/run');
    let done = 0;
    const jobs = toAsk.flatMap((r) => Array.from({ length: REPS }, (_, rep) => ({ r, rep })));
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const { r, rep } = jobs[next++];
        try {
          const res = await callMany(r.state, QUESTIONS);
          for (const k of QKEYS) ((jev[r.id] ??= {})[k] ??= [])[rep] = read({ q: QUESTIONS[k], expect: [] }, res.answers[k]);
        } catch (e) { console.log(`  ✗ ${r.id}: ${e.message}`); }
        done++;
        if (done % 10 === 0 || done === jobs.length) process.stdout.write(`  ${done}/${jobs.length}\n`);
      }
    };
    console.log(`\nAsking Jev: ${jobs.length} calls`);
    await Promise.all(Array.from({ length: 4 }, worker));
  } else if (!SEND) {
    console.log('\nDry run — nothing was sent. Review to-send.json, then rerun with --send.');
  }

  // ---------- 3. decisions ----------
  const majority = (arr) => { const c = {}; for (const m of arr) c[m] = (c[m] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const decisions = rows.map((r) => {
    const j = jev[r.id]?.junk, k = jev[r.id]?.kind;
    const junk = j ? { mode: majority(j.map((x) => x.mode)), confidence: mean(j.map((x) => x.confidence ?? 0)), dist: Object.fromEntries(Object.keys(j[0].dist).map((key) => [key, mean(j.map((x) => x.dist[key]))])) } : null;
    const kind = k ? { mode: majority(k.map((x) => x.mode)), confidence: mean(k.map((x) => x.confidence ?? 0)), dist: Object.fromEntries(Object.keys(k[0].dist).map((key) => [key, mean(k.map((x) => x.dist[key]))])) } : null;
    const d = r.rule.verdict ? decide(r.state, null, TAU) : junk ? decide(r.state, junk, TAU) : { column: 'unsure', by: 'none', reason: SEND ? 'no reading returned' : 'not asked yet (dry run)' };
    return { id: r.id, file: r.file, thumbnail: r.thumbnail, dates: r.dates, state: r.state, rule: r.rule, junk, kind, decision: d, summary: summ(r.state) };
  });
  const cols = { delete: decisions.filter((x) => x.decision.column === 'delete'), unsure: decisions.filter((x) => x.decision.column === 'unsure'), keep: decisions.filter((x) => x.decision.column === 'keep') };
  console.log(`\nSuggest delete ${cols.delete.length} · Not sure ${cols.unsure.length} · Keep ${cols.keep.length}`);
  for (const [col, list] of Object.entries(cols)) for (const x of list) console.log(`  ${({ delete: 'DEL', unsure: '???', keep: 'KEEP' })[col].padEnd(4)} ${x.id.slice(0, 34).padEnd(34)} ${x.decision.by === 'rule' ? 'rule' : x.decision.by === 'jev' ? 'Jev ' : '    '} ${x.decision.reason}${x.kind ? `  · kind ${x.kind.mode} ${x.kind.confidence.toFixed(2)}` : ''}`);
  const out = { generatedAt: new Date().toISOString(), source: F.source, mode: F.mode, sent: SEND, tau: TAU, reps: REPS, model: SEND ? '~typesafe/jev-latest' : null, decisions };
  fs.writeFileSync(path.join(outDir, 'decisions.json'), JSON.stringify(out, null, 1));

  // ---------- 4. review.html ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const junkLabel = QUESTIONS.junk.criteria;
  const bars = (dist, labels, exp) => Object.entries(dist).map(([k, p]) => `<div class="l" title="${esc(labels[k] ?? k)}">${esc(labels[k] ?? k)}</div><div class="track"><div class="fill ${k === exp ? 'top' : ''}" style="width:${(p * 100).toFixed(0)}%"></div></div><div class="p">${p.toFixed(2)}</div>`).join('');
  const card = (x) => `<div class="card">
    ${x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="">` : '<div class="noimg">no thumbnail</div>'}
    <div class="body">
      <div class="file" title="${esc(x.file)}">${esc(x.file)}</div>
      <div class="why ${x.decision.by}">${x.decision.by === 'rule' ? 'rule' : x.decision.by === 'jev' ? 'Jev' : '—'} · ${esc(x.decision.reason)}</div>
      ${x.junk ? `<div class="bars">${bars(x.junk.dist, junkLabel, x.junk.mode)}</div><div class="meta">confidence ${x.junk.confidence.toFixed(2)}${x.kind ? ` · kind <b>${esc(x.kind.mode)}</b> ${x.kind.confidence.toFixed(2)}` : ''}</div>` : ''}
      <div class="meta">${esc(x.summary)}</div>
      <details><summary>state</summary><pre>${esc(JSON.stringify(x.state, null, 1))}</pre></details>
    </div></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>jevtophoto · review</title>
<style>
:root{color-scheme:light dark;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--border:rgba(11,11,11,.1);--s1:#2a78d6;--de:#c3c2b7;--good:#006300;--critical:#d03b3b;--warning:#b57a00;
--sans:"IBM Plex Sans",system-ui,-apple-system,sans-serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--grid:#2c2c2a;--border:rgba(255,255,255,.1);--s1:#3987e5;--de:#52514e;--good:#0ca30c;--critical:#e66767;--warning:#fab219}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45}
.wrap{max-width:1600px;margin:0 auto;padding:20px clamp(16px,3vw,28px) 80px}h1{font-size:19px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.col h2{font-size:15px;margin:0 0 10px;display:flex;justify-content:space-between;align-items:baseline}.col h2 span{color:var(--muted);font-weight:400;font-size:13px}
.col.delete h2{color:var(--critical)}.col.unsure h2{color:var(--warning)}.col.keep h2{color:var(--good)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px;display:grid;grid-template-columns:120px minmax(0,1fr)}
.card img{width:120px;height:120px;object-fit:cover;display:block;background:var(--grid)}.noimg{width:120px;height:120px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;background:var(--grid)}
.body{padding:8px 10px;min-width:0}.file{font-family:var(--mono);font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.why{font-size:12.5px;margin:3px 0}.why.rule{color:var(--ink-2)}.why.jev{color:var(--ink)}.meta{font-size:11.5px;color:var(--muted);margin-top:3px;word-break:break-all}.meta b{color:var(--ink);font-weight:500}
.bars{display:grid;grid-template-columns:96px 1fr 32px;gap:1px 6px;align-items:center;font-size:11px;margin-top:4px}.bars .l{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bars .track{height:7px;background:var(--grid);border-radius:3px;overflow:hidden}.bars .fill{height:100%;background:var(--de)}.bars .fill.top{background:var(--s1)}.bars .p{text-align:right;color:var(--ink-2);font-variant-numeric:tabular-nums}
details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:11.5px}pre{font-family:var(--mono);font-size:10.5px;white-space:pre-wrap;color:var(--ink-2);margin:4px 0 0}
.foot{margin-top:24px;color:var(--muted);font-size:12.5px}
</style></head><body><div class="wrap">
<h1>jevtophoto · review</h1>
<p class="sub">${esc(F.source)} (${esc(F.mode)} mode) · ${decisions.length} images · ${SEND ? `Jev ${out.model}, gate ${TAU}, ${REPS} run(s) per image` : '<b>Jev not asked yet</b> (dry run): anything the rules don\'t cover is under "Not sure"'} · ${decisions.filter((x) => x.decision.by === 'rule').length} decided by rules, ${decisions.filter((x) => x.decision.by === 'jev').length} by Jev · generated ${out.generatedAt.slice(0, 16).replace('T', ' ')}Z</p>
<div class="cols">
${['delete', 'unsure', 'keep'].map((c) => `<div class="col ${c}"><h2>${({ delete: 'Suggest delete', unsure: 'Not sure', keep: 'Keep' })[c]} <span>${cols[c].length}</span></h2>${cols[c].map(card).join('')}</div>`).join('')}
</div>
<p class="foot">This page deletes nothing. No pixels, file names or OCR text were sent; the exact JSON sent is in to-send.json. Rules: hidden, shared-album and screenshots from the last 14 days are not candidates; favorited, user-edited and user-picked burst frames are kept; identical copies and non-sharpest burst frames are suggested for deletion; everything else follows the majority of Jev's junk question, and "not sure" or confidence &lt; ${TAU} goes to "Not sure".</p>
</div></body></html>`;
  fs.writeFileSync(path.join(outDir, 'review.html'), html);
  console.log(`\nWrote ${path.join(outDir, 'decisions.json')} and ${path.join(outDir, 'review.html')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
