// 代码硬规则：能从字段直接定的，不问模型（A 方案的结论，RESULTS.md 第 9 节）。
// applyRules(state) → { verdict: 'skip' | 'keep' | 'delete' | null, reason }
//   skip    不进候选，用户根本不会看到（隐藏的、共享相簿的、太新的截图）
//   keep    进「保留」栏并给出理由（收藏、用户编辑过、连拍里用户选中）
//   delete  进「建议删除」栏并给出理由（一模一样的副本、连拍 / 连按快门里不是最清晰又没被选中的）
//   null    交给 Jev
// decide(state, jev, tau) → { column: 'delete' | 'unsure' | 'keep', by: 'rule' | 'jev', reason }
//   jev 是 junk 题的一次读数 { mode, confidence }；众数「说不准」或置信度 < tau 一律进「拿不准」。
const RECENT_SCREENSHOT_DAYS = 14;
const DEFAULT_TAU = 0.3;

function applyRules(state, opts = {}) {
  const recentDays = opts.recentScreenshotDays ?? RECENT_SCREENSHOT_DAYS;
  const a = state.asset, d = state.derived;
  if (a.isHidden) return { verdict: 'skip', reason: '隐藏的' };
  if (a.sourceType === 'typeCloudShared') return { verdict: 'skip', reason: '共享相簿里的' };
  if (a.isFavorite) return { verdict: 'keep', reason: '收藏了' };
  if (a.adjustmentsState === 'userAdjusted') return { verdict: 'keep', reason: '用户编辑过' };
  if ((a.burstSelectionTypes ?? []).includes('userPick')) return { verdict: 'keep', reason: '连拍里用户选中的' };
  if ((a.mediaSubtypes ?? []).includes('photoScreenshot') && d.daysSinceCreation < recentDays) return { verdict: 'skip', reason: `${recentDays} 天内的截图` };
  if (d.exactDuplicateCount > 0) return { verdict: 'delete', reason: '有一模一样的副本' };
  if (d.isSharpestInBurst === false && (a.burstSelectionTypes ?? []).length === 0) {
    return { verdict: 'delete', reason: a.burstIdentifier ? '连拍里不是最清晰的' : '连按快门里不是最清晰的' };
  }
  return { verdict: null, reason: null };
}

const LEVEL_LABEL = ['明显该删', '大概率该删', '说不准', '该留'];

function decide(state, jev, tau = DEFAULT_TAU, opts = {}) {
  const r = applyRules(state, opts);
  if (r.verdict === 'delete') return { column: 'delete', by: 'rule', reason: r.reason };
  if (r.verdict === 'keep' || r.verdict === 'skip') return { column: 'keep', by: 'rule', reason: r.reason, skipped: r.verdict === 'skip' };
  if (!jev) return { column: 'unsure', by: 'none', reason: '没有模型读数' };
  const mode = String(jev.mode), conf = jev.confidence ?? 0;
  if (mode === '2' || conf < tau) return { column: 'unsure', by: 'jev', reason: mode === '2' ? '模型说不准' : `置信度 ${conf.toFixed(2)} 不到 ${tau}` };
  return { column: mode === '3' ? 'keep' : 'delete', by: 'jev', reason: `${LEVEL_LABEL[Number(mode)]}，置信度 ${conf.toFixed(2)}` };
}

module.exports = { applyRules, decide, RECENT_SCREENSHOT_DAYS, DEFAULT_TAU };

if (require.main === module) {
  const { records } = require('./items');
  const by = {};
  for (const r of records) { const v = applyRules(r.state); const k = v.verdict ?? 'jev'; (by[k] ??= []).push(`${r.id}${v.reason ? `（${v.reason}）` : ''}`); }
  for (const [k, list] of Object.entries(by)) console.log(`${k.padEnd(7)} ${list.length} 条\n  ${list.join('\n  ')}`);
}
