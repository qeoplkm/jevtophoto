// Hard rules in code: anything decidable directly from the fields is not sent to the model (phase A conclusion, see RESULTS.md).
// applyRules(state) → { verdict: 'skip' | 'keep' | 'delete' | null, reason }
//   skip    not a candidate at all; the user never sees it (hidden, shared album, very recent screenshot)
//   keep    goes to "Keep" with a reason (favorited, user-edited, picked by the user within a burst)
//   delete  goes to "Suggest delete" with a reason (identical copy exists; non-sharpest, unpicked frame of a burst / rapid-fire sequence)
//   null    left to Jev
// decide(state, jev, tau) → { column: 'delete' | 'unsure' | 'keep', by: 'rule' | 'jev', reason }
//   jev is one reading of the junk question { mode, confidence, dist? }. These always go to "Not sure":
//   mode "2", confidence < tau, a mode other than 0/1/3, or a top-probability tie that spans more than one column
//   (delete = 0 or 1, not sure = 2, keep = 3). A tie inside one column still uses the modal level.
//   The same rule is in ios/.../Model/Rules.swift (tiedAcrossColumns).
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
const LEVEL_KEYS = ['0', '1', '2', '3'];

// True when the highest probability is shared by levels that are not all the same column.
// Missing or non-numeric levels are ignored, so a partial dist cannot invent a tie.
function tiedAcrossColumns(dist) {
  if (!dist || typeof dist !== 'object') return false;
  let best = null;
  for (const k of LEVEL_KEYS) {
    const p = Number(dist[k]);
    if (!Number.isFinite(p)) continue;
    if (best === null || p > best) best = p;
  }
  if (best === null) return false;
  const tied = LEVEL_KEYS.filter((k) => Number(dist[k]) === best);
  if (tied.length < 2) return false;
  const column = (k) => (k === '3' ? 'keep' : k === '2' ? 'unsure' : 'delete');
  return new Set(tied.map(column)).size > 1;
}

function decide(state, jev, tau = DEFAULT_TAU, opts = {}) {
  const r = applyRules(state, opts);
  if (r.verdict === 'delete') return { column: 'delete', by: 'rule', reason: r.reason };
  if (r.verdict === 'keep' || r.verdict === 'skip') return { column: 'keep', by: 'rule', reason: r.reason, skipped: r.verdict === 'skip' };
  if (!jev) return { column: 'unsure', by: 'none', reason: 'no model reading' };
  const mode = String(jev.mode), conf = Number(jev.confidence);
  const confidence = Number.isFinite(conf) ? conf : 0;
  const tied = tiedAcrossColumns(jev.dist);
  const known = mode === '0' || mode === '1' || mode === '3';
  if (tied || !known || confidence < tau) {
    const reason = tied ? 'top probability is tied'
      : mode === '2' ? 'model is not sure'
      : !known ? 'no unique level'
      : `confidence ${confidence.toFixed(2)} below ${tau}`;
    return { column: 'unsure', by: 'jev', reason };
  }
  return { column: mode === '3' ? 'keep' : 'delete', by: 'jev', reason: `${LEVEL_LABEL[Number(mode)]}, confidence ${confidence.toFixed(2)}` };
}

module.exports = { applyRules, decide, tiedAcrossColumns, RECENT_SCREENSHOT_DAYS, DEFAULT_TAU };

if (require.main === module) {
  const { records } = require('./items');
  const by = {};
  for (const r of records) { const v = applyRules(r.state); const k = v.verdict ?? 'jev'; (by[k] ??= []).push(`${r.id}${v.reason ? ` (${v.reason})` : ''}`); }
  for (const [k, list] of Object.entries(by)) console.log(`${k.padEnd(7)} ${list.length} records\n  ${list.join('\n  ')}`);
}
