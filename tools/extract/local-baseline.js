// 「全本地」对照：不调 Jev，把激进档的政策写成阈值规则，看和 Jev 在同一批照片上差多少。
//   node tools/extract/local-baseline.js <decisions.json>   # 手机或 Mac 抽出来的结果（含 Jev 判定）
//   node tools/extract/local-baseline.js --bank             # 在题库上对标准答案
const fs = require('node:fs');
const path = require('node:path');
const { applyRules } = require('../capability/rules');

// 激进档同款政策，只是每条都得自己定阈值
function localDecide(state, recentDays = 3) {
  const r = applyRules(state, { recentScreenshotDays: recentDays });
  if (r.verdict === 'delete') return { column: 'delete', reason: r.reason };
  if (r.verdict) return { column: 'keep', reason: r.reason };
  const a = state.asset, v = state.vision, d = state.derived, cam = state.imageProperties.TIFF.Model != null;
  if (v.faceCount > 0) return { column: 'keep', reason: '有人脸' };
  if (d.ocrDocType === 'id_document') return { column: 'keep', reason: '证件' };
  if (d.ocrDocType !== 'none') return d.daysSinceCreation <= 90 ? { column: 'keep', reason: `${d.ocrDocType} 90 天内` } : { column: 'delete', reason: `${d.ocrDocType} 超过 90 天` };
  if ((d.sharpness ?? 1) < 0.25 || (d.meanLuminance ?? 1) < 0.06) return { column: 'delete', reason: '糊图 / 黑图' };
  if (a.mediaSubtypes.includes('photoScreenshot') || !cam) return d.daysSinceCreation >= 7 ? { column: 'delete', reason: '截图 / 存图超过一周' } : { column: 'unsure', reason: '截图 / 存图不到一周' };
  if (v.aesthetics.isUtility && v.recognizedTextCharCount >= 30) return d.daysSinceCreation > 14 ? { column: 'delete', reason: '文档照片超过两周' } : { column: 'unsure', reason: '文档照片两周内' };
  return { column: 'keep', reason: '相机拍的' };
}

const colZh = { delete: '删', unsure: '？', keep: '留' };
const feat = (s) => { const v = s.vision, d = s.derived, t = s.imageProperties.TIFF, a = s.asset; return [a.mediaType === 'video' ? 'video' : null, ...a.mediaSubtypes, t.Model ? 'cam' : 'noEXIF', `脸${v.faceCount}`, `字${v.recognizedTextCharCount}`, d.ocrDocType !== 'none' ? d.ocrDocType : null, v.aesthetics.isUtility ? 'util' : null, `美${v.aesthetics.overallScore}`, `清${d.sharpness}`, `亮${d.meanLuminance}`, `${d.daysSinceCreation}d`].filter(Boolean).join(' '); };

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
    if (d.column !== 'unsure' && !gold.includes(d.column)) wrong.push(`${r.id}→${colZh[d.column]}`); }
  console.log(`全本地（激进政策写成阈值）在题库上：伤害 ${harm.length} [${harm.join(', ')}] 漏网 ${miss.length} [${miss.join(', ')}] 错 ${wrong.length} [${wrong.join(', ')}] 拿不准 ${unsure}`);
} else {
  const F = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const recs = F.decisions ?? F.records;
  const m = {}; const dis = [];
  for (const r of recs) { const l = localDecide(r.state, F.recentScreenshotDays ?? 3); const j = r.decision.column; m[`${colZh[l.column]}/${colZh[j]}`] = (m[`${colZh[l.column]}/${colZh[j]}`] ?? 0) + 1; if (l.column !== j) dis.push({ r, l }); }
  console.log(`${recs.length} 张：本地 / Jev 栏位组合`, m);
  console.log(`不一致 ${dis.length} 张：`);
  for (const { r, l } of dis) console.log(`  本地${colZh[l.column]}（${l.reason}）  Jev${colZh[r.decision.column]}（${r.decision.reason}${r.kind ? `，kind ${r.kind.mode}` : ''}）  ${feat(r.state)}${r.feedback ? `  👤${r.feedback}` : ''}`);
}
