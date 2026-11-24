// Identical files must not all be suggested for deletion.
//   node --test tools/extract/duplicates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeState } = require('../capability/items');
const { applyRules } = require('../capability/rules');
const { exactDuplicateCounts } = require('./duplicates');

const photo = (sha, sharpness, extra = {}) => ({ sha, sharpness, ...extra });

test('the sharper of two identical photos is the one the delete rule leaves alone', () => {
  const counts = exactDuplicateCounts([photo('a', 0.4), photo('a', 0.9)]);
  assert.deepEqual(counts, [1, 0]);
  const blurry = makeState('dup-blurry', { exactDuplicateCount: counts[0], sharpness: 0.4 }).state;
  const sharp = makeState('dup-sharp', { exactDuplicateCount: counts[1], sharpness: 0.9 }).state;
  assert.equal(applyRules(blurry).verdict, 'delete');
  assert.equal(applyRules(sharp).verdict, null);
});

test('a tie keeps the earliest copy', () => {
  assert.deepEqual(exactDuplicateCounts([photo('a', 0.5), photo('a', 0.5), photo('a', 0.5)]), [0, 2, 2]);
});

test('a missing sharpness loses to a measured one, including zero', () => {
  assert.deepEqual(exactDuplicateCounts([photo('a', null), photo('a', 0)]), [1, 0]);
  assert.deepEqual(exactDuplicateCounts([photo('a', undefined), photo('a', 0.1)]), [1, 0]);
});

test('three copies spare only the sharpest', () => {
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2), photo('a', 0.8), photo('a', 0.5)]),
    [2, 0, 2],
  );
});

test('a favorite, user edit, or user pick already saves a copy, so the real count stays', () => {
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2, { isFavorite: true }), photo('a', 0.95)]),
    [1, 1],
  );
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2, { adjustmentsState: 'userAdjusted' }), photo('a', 0.95)]),
    [1, 1],
  );
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2, { burstSelectionTypes: ['userPick'] }), photo('a', 0.95)]),
    [1, 1],
  );
  // Automatic camera processing is not a user edit, so it does not save every copy.
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2, { adjustmentsState: 'cameraAutoAdjusted' }), photo('a', 0.95)]),
    [1, 0],
  );
  const fav = makeState('dup-fav', { exactDuplicateCount: 1, isFavorite: true, sharpness: 0.2 }).state;
  const other = makeState('dup-other', { exactDuplicateCount: 1, sharpness: 0.95 }).state;
  assert.equal(applyRules(fav).verdict, 'keep');
  assert.equal(applyRules(fav).reason, 'favorited');
  assert.equal(applyRules(other).verdict, 'delete');
});

test('distinct files, a single file, and missing hashes are not duplicates', () => {
  assert.deepEqual(exactDuplicateCounts([photo('a', 0.2), photo('b', 0.9)]), [0, 0]);
  assert.deepEqual(exactDuplicateCounts([photo('a', 0.4)]), [0]);
  assert.deepEqual(exactDuplicateCounts([photo('', 0.2), photo('', 0.9), photo(null, 0.4), photo(undefined, 0.5)]), [0, 0, 0, 0]);
});

test('two hash groups are spared independently', () => {
  assert.deepEqual(
    exactDuplicateCounts([photo('a', 0.2), photo('b', 0.3), photo('a', 0.9), photo('b', 0.1)]),
    [1, 0, 0, 1],
  );
});
