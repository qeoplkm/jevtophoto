// Ablations: same bank, same state shape, change exactly one thing and see how much the junk question moves.
// Results go to results-ablation-<name>.json; report.js adds a comparison section when it finds them.
//   node tools/capability/ablate.js               # run all ablations
//   node tools/capability/ablate.js anchors       # run one
const { records } = require('./items');
const { runBank } = require('./run');

// Each patch must actually change the instructions; a silent no-op would make the ablation meaningless.
const patch = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`ablation patch target not found in instructions: "${from}"`);
  return text.replace(from, to);
};
const anchorQ = (q) => ({ ...q, instructions: patch(patch(q.instructions,
  'aesthetics.overallScore is an aesthetics score from −1 to 1 (higher is better looking)',
  'aesthetics.overallScore is an aesthetics score from −1 to 1: 0 and above is usually a presentable photo, below −0.5 is usually a screenshot, document or reject'),
  'faceCount is the number of faces', 'faceCount is the number of faces (≥ 1 counts as having faces)') });
// Put PhotoKit's raw creationDate / addedDate strings back into asset (after duration, matching PHAsset's property order)
const datesOf = Object.fromEntries(records.map((r) => [r.id, r.dates]));
const rawDates = (s, item) => {
  const asset = {};
  for (const [k, v] of Object.entries(s.asset)) { asset[k] = v; if (k === 'duration') Object.assign(asset, datesOf[item.rec]); }
  return { ...s, asset };
};
const rawDatesQ = (q) => ({ ...q, instructions: patch(q.instructions,
  'daysSinceAdded is days since it entered the library (much smaller than daysSinceCreation usually means it was received or imported later)',
  'daysSinceAdded is days since it entered the library; in asset, an addedDate much later than creationDate usually means it was received or imported later') });

const ABLATIONS = {
  rawdates: { desc: 'add PhotoKit\'s raw creationDate / addedDate strings back into the state', transformState: rawDates, transformQ: rawDatesQ },
  anchors: { desc: 'give overallScore an explicit scale in the instructions (≥ 0 good photo, < −0.5 mostly screenshots / documents / rejects) and state that faceCount ≥ 1 means faces', transformQ: anchorQ },
};

async function main() {
  const only = process.argv.slice(2);
  for (const [name, a] of Object.entries(ABLATIONS)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n== ${name}: ${a.desc}`);
    const out = await runBank({ todo: records, tag: `-ablation-${name}`, transformQ: a.transformQ, transformState: a.transformState });
    const junk = out.results.filter((r) => r.qkey === 'junk');
    const acc = (rs) => { let ok = 0, n = 0; for (const r of rs) for (const x of r.runs) { n++; if (x.correct) ok++; } return `${ok}/${n}`; };
    console.log(`  junk clear ${acc(junk.filter((r) => !r.edge && r.cat !== 'robust'))}, borderline ${acc(junk.filter((r) => r.edge))}`);
  }
}

module.exports = { ABLATIONS, anchorQ, rawDatesQ };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
