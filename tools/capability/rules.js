// Hard rules in code: anything decidable directly from the fields is not sent to the model (phase A conclusion, see RESULTS.md).
// applyRules(state) → { verdict: 'skip' | 'keep' | 'delete' | null, reason }
//   skip    not a candidate at all; the user never sees it (hidden, shared album, very recent screenshot)
//   keep    goes to "Keep" with a reason (favorited, user-edited, picked by the user within a burst)
//   delete  goes to "Suggest delete" with a reason (identical copy exists; non-sharpest, unpicked frame of a burst / rapid-fire sequence)
//   null    left to Jev
// decide(state, jev, tau) → { column: 'delete' | 'unsure' | 'keep', by: 'rule' | 'jev', reason }
//   jev is one reading of the junk question { mode, confidence }; a "not sure" mode or confidence < tau always goes to "Not sure".
const RECENT_SCREENSHOT_DAYS = 14;
const DEFAULT_TAU = 0.3;

function applyRules(state, opts = {}) {
  const recentDays = opts.recentScreenshotDays ?? RECENT_SCREENSHOT_DAYS;
  const a = state.asset, d = state.derived;
  if (a.isHidden) return { verdict: 'skip', reason: 'hidden' };
  if (a.sourceType === 'typeCloudShared') return { verdict: 'skip', reason: 'in a shared album' };
  if (a.isFavorite) return { verdict: 'keep', reason: 'favorited' };
  if (a.adjustmentsState === 'userAdjusted') return { verdict: 'keep', reason: 'edited by the user' };
  if ((a.burstSelectionTypes ?? []).includes('userPick')) return { verdict: 'keep', reason: 'picked by the user in a burst' };
  if ((a.mediaSubtypes ?? []).includes('photoScreenshot') && d.daysSinceCreation < recentDays) return { verdict: 'skip', reason: `screenshot from the last ${recentDays} days` };
  if (d.exactDuplicateCount > 0) return { verdict: 'delete', reason: 'an identical copy exists' };
  if (d.isSharpestInBurst === false && (a.burstSelectionTypes ?? []).length === 0) {
    return { verdict: 'delete', reason: a.burstIdentifier ? 'not the sharpest frame of the burst' : 'not the sharpest of a rapid-fire sequence' };
  }
  return { verdict: null, reason: null };
}

const LEVEL_LABEL = ['clearly delete', 'probably delete', 'not sure', 'keep'];

function decide(state, jev, tau = DEFAULT_TAU, opts = {}) {
  const r = applyRules(state, opts);
  if (r.verdict === 'delete') return { column: 'delete', by: 'rule', reason: r.reason };
  if (r.verdict === 'keep' || r.verdict === 'skip') return { column: 'keep', by: 'rule', reason: r.reason, skipped: r.verdict === 'skip' };
  if (!jev) return { column: 'unsure', by: 'none', reason: 'no model reading' };
  const mode = String(jev.mode), conf = jev.confidence ?? 0;
  if (mode === '2' || conf < tau) return { column: 'unsure', by: 'jev', reason: mode === '2' ? 'model is not sure' : `confidence ${conf.toFixed(2)} below ${tau}` };
  return { column: mode === '3' ? 'keep' : 'delete', by: 'jev', reason: `${LEVEL_LABEL[Number(mode)]}, confidence ${conf.toFixed(2)}` };
}

module.exports = { applyRules, decide, RECENT_SCREENSHOT_DAYS, DEFAULT_TAU };

if (require.main === module) {
  const { records } = require('./items');
  const by = {};
  for (const r of records) { const v = applyRules(r.state); const k = v.verdict ?? 'jev'; (by[k] ??= []).push(`${r.id}${v.reason ? ` (${v.reason})` : ''}`); }
  for (const [k, list] of Object.entries(by)) console.log(`${k.padEnd(7)} ${list.length} records\n  ${list.join('\n  ')}`);
}
