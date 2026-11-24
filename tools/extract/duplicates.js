// How many identical copies each photo has, for the hard rule in rules.js.
//
// That rule suggests deletion whenever exactDuplicateCount > 0. Counting every
// file in a hash group (the old extractor behavior) therefore suggests deleting
// the whole group, including the last copy. A favorite, a user edit, or a user
// pick is already kept by an earlier rule, so those groups can still report the
// real count. Otherwise the sharpest copy — the earliest one if sharpness ties —
// is reported as 0 and the others as "everyone else", so one copy is left for
// Jev instead of being swept up with the duplicates.
//
// Same rule in tools/extract/extract.swift and ios/.../Pipeline/Extractor.swift.
function copyIsKeptAnyway(it) {
  return it.isFavorite === true
    || it.adjustmentsState === 'userAdjusted'
    || (it.burstSelectionTypes ?? []).includes('userPick');
}

function sharpnessOf(it) {
  const s = it.sharpness;
  return typeof s === 'number' && Number.isFinite(s) ? s : -Infinity;
}

function exactDuplicateCounts(items) {
  const groups = new Map();
  items.forEach((it, i) => {
    const sha = it.sha;
    if (sha == null || sha === '') return;
    let g = groups.get(sha);
    if (!g) groups.set(sha, (g = []));
    g.push(i);
  });
  const counts = items.map(() => 0);
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let spare = -1;
    if (!idxs.some((i) => copyIsKeptAnyway(items[i]))) {
      spare = idxs[0];
      for (const i of idxs) if (sharpnessOf(items[i]) > sharpnessOf(items[spare])) spare = i;
    }
    for (const i of idxs) counts[i] = i === spare ? 0 : idxs.length - 1;
  }
  return counts;
}

module.exports = { exactDuplicateCounts };
