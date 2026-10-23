// Rules-only baselines (the README's "what does Jev add over rules?"): no model, fields only, output delete / keep.
//   rules3   the README's three rules: screenshot ≥ 90 days old with no faces → delete; non-sharpest burst frame → delete; exact duplicate → delete.
//            (the original idea was "not viewed for 90 days", but PhotoKit has no view time, so daysSinceCreation is used)
//   utility  rules3 plus Vision's isUtility: utility image, no faces, not favorited, not user-edited, ≥ 90 days old → delete.
// Both baselines only ever say delete / keep, never "not sure" — which is exactly what Jev is compared on.
//
//   node tools/capability/baseline.js   # run both baselines on the bank and score them against the answer key
const { records } = require('./items');

const flat = (state) => ({ ...state.asset, ...state.resource, ...state.imageProperties.TIFF, ...state.imageProperties.Exif,
  ...state.vision, ...state.vision.aesthetics, ...state.derived });

function rules3(state) {
  const s = flat(state);
  if (s.exactDuplicateCount > 0) return { decision: 'delete', rule: 'exact duplicate' };
  if (s.isSharpestInBurst === false) return { decision: 'delete', rule: 'non-sharpest burst frame' };
  if (s.mediaSubtypes.includes('photoScreenshot') && s.faceCount === 0 && s.daysSinceCreation >= 90) return { decision: 'delete', rule: 'screenshot ≥ 90 days, no faces' };
  return { decision: 'keep', rule: null };
}

function utility(state) {
  const r = rules3(state);
  if (r.decision === 'delete') return r;
  const s = flat(state);
  if (s.isUtility && s.faceCount === 0 && !s.isFavorite && s.adjustmentsState !== 'userAdjusted' && s.daysSinceCreation >= 90) return { decision: 'delete', rule: 'isUtility ≥ 90 days, no faces' };
  return { decision: 'keep', rule: null };
}

const BASELINES = { rules3, utility };

// junk level → decision; the answer key is a set of levels, so the gold decision is a set too
const levelDecision = (lvl) => ({ 0: 'delete', 1: 'delete', 2: 'unsure', 3: 'keep' })[Number(lvl)];
const goldDecisions = (expectJunk) => [...new Set(expectJunk.map(levelDecision))];

module.exports = { BASELINES, rules3, utility, levelDecision, goldDecisions, flat };

if (require.main === module) {
  for (const [name, fn] of Object.entries(BASELINES)) {
    let ok = 0, okClear = 0, nClear = 0, okEdge = 0, nEdge = 0;
    const misses = [];
    for (const r of records) {
      const gold = goldDecisions(r.expect.junk);
      const d = fn(r.state).decision;
      const hit = gold.includes(d);
      if (hit) ok++;
      if (r.edge) { nEdge++; if (hit) okEdge++; } else { nClear++; if (hit) okClear++; }
      if (!hit) misses.push(`  ${(r.edge ? '⚑ ' : '  ') + r.id.padEnd(32)} baseline ${d.padEnd(7)} expected ${gold.join('|')}`);
    }
    console.log(`${name}: ${ok}/${records.length} (clear ${okClear}/${nClear}, borderline ${okEdge}/${nEdge})`);
    console.log(misses.join('\n'));
  }
}
