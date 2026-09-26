// 纯规则基线（README「必须回答的对照问题」）：不调模型，只看字段，给出 delete / keep。
//   rules3   README 原话的三条：截图 90 天以上且无人脸 → 删；连拍非最清晰 → 删；精确重复 → 删。
//            （README 写的是「90 天没看过」，PhotoKit 没有查看时间，只能用 daysSinceCreation）
//   utility  rules3 之上再加 Vision 的 isUtility：实用图、无人脸、没收藏、用户没编辑过、拍摄 90 天以上 → 删。
// 两个基线都只会说 delete / keep，没有「说不准」——这正是要和 Jev 比的地方。
//
//   node tools/capability/baseline.js   # 在题库上跑两个基线，和标准答案对
const { records } = require('./items');

const flat = (state) => ({ ...state.asset, ...state.resource, ...state.imageProperties.TIFF, ...state.imageProperties.Exif,
  ...state.vision, ...state.vision.aesthetics, ...state.derived });

function rules3(state) {
  const s = flat(state);
  if (s.exactDuplicateCount > 0) return { decision: 'delete', rule: '精确重复' };
  if (s.isSharpestInBurst === false) return { decision: 'delete', rule: '连拍非最清晰' };
  if (s.mediaSubtypes.includes('photoScreenshot') && s.faceCount === 0 && s.daysSinceCreation >= 90) return { decision: 'delete', rule: '截图 ≥90 天无人脸' };
  return { decision: 'keep', rule: null };
}

function utility(state) {
  const r = rules3(state);
  if (r.decision === 'delete') return r;
  const s = flat(state);
  if (s.isUtility && s.faceCount === 0 && !s.isFavorite && s.adjustmentsState !== 'userAdjusted' && s.daysSinceCreation >= 90) return { decision: 'delete', rule: 'isUtility ≥90 天无人脸' };
  return { decision: 'keep', rule: null };
}

const BASELINES = { rules3, utility };

// junk 档位 → 决策；标准答案是档位集合，所以决策也是集合
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
      if (!hit) misses.push(`  ${(r.edge ? '⚑ ' : '  ') + r.id.padEnd(32)} 基线 ${d.padEnd(7)} 标准 ${gold.join('|')}`);
    }
    console.log(`${name}: ${ok}/${records.length}（清晰 ${okClear}/${nClear}，边界 ${okEdge}/${nEdge}）`);
    console.log(misses.join('\n'));
  }
}
