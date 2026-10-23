// Fully local comparison: no Jev calls; the aggressive policy written as threshold rules, compared with Jev on the same photos.
//   node tools/extract/local-baseline.js <decisions.json>   # results from the phone or the Mac extractor (with Jev's decisions)
//   node tools/extract/local-baseline.js --bank             # against the bank's answer key
const fs = require('node:fs');
const path = require('node:path');
const { applyRules } = require('../capability/rules');

// The same policy as the aggressive profile, except every condition needs a hand-picked threshold
function localDecide(state, recentDays = 3) {
  const r = applyRules(state, { recentScreenshotDays: recentDays });
  if (r.verdict === 'delete') return { column: 'delete', reason: r.reason };
  if (r.verdict) return { column: 'keep', reason: r.reason };
  const a = state.asset, v = state.vision, d = state.derived, cam = state.imageProperties.TIFF.Model != null;
  if (v.faceCount > 0) return { column: 'keep', reason: 'has faces' };
  if (d.ocrDocType === 'id_document') return { column: 'keep', reason: 'ID document' };
  if (d.ocrDocType !== 'none') return d.daysSinceCreation <= 90 ? { column: 'keep', reason: `${d.ocrDocType} within 90 days` } : { column: 'delete', reason: `${d.ocrDocType} older than 90 days` };
  if ((d.sharpness ?? 1) < 0.25 || (d.meanLuminance ?? 1) < 0.06) return { column: 'delete', reason: 'blurry / black frame' };
  if (a.mediaSubtypes.includes('photoScreenshot') || !cam) return d.daysSinceCreation >= 7 ? { column: 'delete', reason: 'screenshot / saved image older than a week' } : { column: 'unsure', reason: 'screenshot / saved image from the last week' };
  if (v.aesthetics.isUtility && v.recognizedTextCharCount >= 30) return d.daysSinceCreation > 14 ? { column: 'delete', reason: 'document photo older than two weeks' } : { column: 'unsure', reason: 'document photo from the last two weeks' };
  return { column: 'keep', reason: 'camera photo' };
}

const colShort = { delete: 'delete', unsure: 'not sure', keep: 'keep' };
const feat = (s) => { const v = s.vision, d = s.derived, t = s.imageProperties.TIFF, a = s.asset; return [a.mediaType === 'video' ? 'video' : null, ...a.mediaSubtypes, t.Model ? 'cam' : 'noEXIF', `faces ${v.faceCount}`, `chars ${v.recognizedTextCharCount}`, d.ocrDocType !== 'none' ? d.ocrDocType : null, v.aesthetics.isUtility ? 'util' : null, `aesth ${v.aesthetics.overallScore}`, `sharp ${d.sharpness}`, `lum ${d.meanLuminance}`, `${d.daysSinceCreation}d`].filter(Boolean).join(' '); };

if (!process.argv[2]) {
  console.error('Usage:\n  node tools/extract/local-baseline.js --bank              # compare against the synthetic bank\'s answer key\n  node tools/extract/local-baseline.js <decisions.json>    # compare with Jev on real photos (from ask.js or the iOS app export)');
  process.exit(2);
} else if (process.argv[2] === '--bank') {
  const { records } = require('../capability/items');
  const { goldDecisions } = require('../capability/baseline');
  let harm = [], miss = [], wrong = [], unsure = 0;
  for (const r of records) { if (r.cat === 'robust') continue; const gold = goldDecisions(r.expect.junk); const d = localDecide(r.state);
    if (d.column === 'unsure') unsure++;
    if (d.column === 'delete' && gold.every((g) => g === 'keep')) harm.push(r.id);
    if (d.column === 'keep' && gold.every((g) => g === 'delete')) miss.push(r.id);
    if (d.column !== 'unsure' && !gold.includes(d.column)) wrong.push(`${r.id} → ${colShort[d.column]}`); }
  console.log(`on the bank: ${harm.length} harmful [${harm.join(', ')}], ${miss.length} missed [${miss.join(', ')}], ${wrong.length} wrong [${wrong.join(', ')}], ${unsure} not sure.`);
} else {
  const F = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const recs = F.decisions ?? F.records;
  const m = {}; const dis = [];
  for (const r of recs) { const l = localDecide(r.state, F.recentScreenshotDays ?? 3); const j = r.decision.column; m[`local ${colShort[l.column]} / Jev ${colShort[j]}`] = (m[`local ${colShort[l.column]} / Jev ${colShort[j]}`] ?? 0) + 1; if (l.column !== j) dis.push({ r, l }); }
  console.log(`${recs.length} images: local vs Jev columns`, m);
  console.log(`${dis.length} disagreements:`);
  for (const { r, l } of dis) console.log(`  local ${colShort[l.column]} (${l.reason})  Jev ${colShort[r.decision.column]} (${r.decision.reason}${r.kind ? `, kind ${r.kind.mode}` : ''})  ${feat(r.state)}${r.feedback ? `  👤${r.feedback}` : ''}`);
}
