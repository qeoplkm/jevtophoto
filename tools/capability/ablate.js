// 消融：同一题库、同一 state 形状，只改一件事，看 junk 题动多少。用来归因 v1 → v2 的准确率变化。
// 结果写到 results-ablation-<name>.json，report.js 读到就会多出一节对照。
//   node tools/capability/ablate.js               # 跑全部消融
//   node tools/capability/ablate.js anchors       # 只跑一个
const { records } = require('./items');
const { runBank } = require('./run');

const anchorQ = (q) => ({ ...q, instructions: q.instructions
  .replace('aesthetics.overallScore 美学分 −1 到 1 越高越好看', 'aesthetics.overallScore 美学分 −1 到 1：0 以上通常是拿得出手的照片，−0.5 以下多半是截图、文档或废片')
  .replace('faceCount 人脸数', 'faceCount 人脸数（≥ 1 就算有人脸）') });
// 把 PhotoKit 的 creationDate / addedDate 原始日期串加回 asset（放在 duration 后面，和 PHAsset 的属性顺序一致）
const datesOf = Object.fromEntries(records.map((r) => [r.id, r.dates]));
const rawDates = (s, item) => {
  const asset = {};
  for (const [k, v] of Object.entries(s.asset)) { asset[k] = v; if (k === 'duration') Object.assign(asset, datesOf[item.rec]); }
  return { ...s, asset };
};
const rawDatesQ = (q) => ({ ...q, instructions: q.instructions.replace('daysSinceAdded 进相册距今天数（比拍摄天数小很多通常表示是后来收到或导入的）',
  'daysSinceAdded 进相册距今天数；asset 里的 addedDate 比 creationDate 晚很多通常表示是后来收到或导入的') });

const ABLATIONS = {
  rawdates: { desc: 'state 里加回 creationDate / addedDate 原始日期串（PhotoKit 原样）', transformState: rawDates, transformQ: rawDatesQ },
  anchors: { desc: '指令里给 overallScore 一个刻度（0 以上算好照片，−0.5 以下多半是截图 / 文档 / 废片）并写明 faceCount ≥ 1 就是有人脸', transformQ: anchorQ },
};

async function main() {
  const only = process.argv.slice(2);
  for (const [name, a] of Object.entries(ABLATIONS)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n== ${name}：${a.desc}`);
    const out = await runBank({ todo: records, tag: `-ablation-${name}`, transformQ: a.transformQ, transformState: a.transformState });
    const junk = out.results.filter((r) => r.qkey === 'junk');
    const acc = (rs) => { let ok = 0, n = 0; for (const r of rs) for (const x of r.runs) { n++; if (x.correct) ok++; } return `${ok}/${n}`; };
    console.log(`  junk 清晰 ${acc(junk.filter((r) => !r.edge && r.cat !== 'robust'))}，边界 ${acc(junk.filter((r) => r.edge))}`);
  }
}

module.exports = { ABLATIONS };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
