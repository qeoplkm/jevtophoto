// The junk gate must not suggest deletion when Jev has no unique column.
//   node --test tools/capability/decision.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeState, QUESTIONS } = require('./items');
const { decide, DEFAULT_TAU } = require('./rules');
const { read } = require('./run');

const { state } = makeState('tie', {});
const junkQ = { q: QUESTIONS.junk, expect: [] };

function reading(dist, { mode, confidence = 0.9 } = {}) {
  const parsed = read({ ...junkQ, expect: ['0'] }, { probabilities: dist, confidence });
  return { mode: mode ?? parsed.mode, confidence, dist };
}

test('a delete/keep tie is not suggested for deletion', () => {
  // read() still reports the first modal level; the gate is what refuses to act on it.
  const dist = { 0: 0.5, 1: 0, 2: 0, 3: 0.5 };
  const parsed = read({ ...junkQ, expect: ['0'] }, { probabilities: dist, confidence: 0.9 });
  assert.equal(parsed.mode, '0');
  assert.equal(parsed.lead, 0);
  const d = decide(state, { mode: parsed.mode, confidence: 0.9, dist });
  assert.equal(d.column, 'unsure');
  assert.equal(d.by, 'jev');
  assert.equal(d.reason, 'top probability is tied');
});

test('a delete/not-sure tie is not suggested for deletion', () => {
  const dist = { 0: 0.45, 1: 0.05, 2: 0.45, 3: 0.05 };
  const d = decide(state, reading(dist));
  assert.equal(d.column, 'unsure');
  assert.equal(d.reason, 'top probability is tied');
});

test('a tie inside the delete column still deletes when confidence clears the gate', () => {
  const dist = { 0: 0.43, 1: 0.43, 2: 0.07, 3: 0.07 };
  const parsed = read({ ...junkQ, expect: ['0'] }, { probabilities: dist, confidence: 0.36 });
  assert.equal(parsed.mode, '0');
  const d = decide(state, { mode: parsed.mode, confidence: 0.36, dist });
  assert.equal(d.column, 'delete');
  assert.equal(d.reason, 'clearly delete, confidence 0.36');
});

test('a unique delete or keep level is unchanged', () => {
  assert.equal(decide(state, reading({ 0: 0.92, 1: 0.08, 2: 0, 3: 0 }, { confidence: 0.91 })).column, 'delete');
  assert.equal(decide(state, reading({ 0: 0, 1: 0.05, 2: 0.05, 3: 0.9 }, { confidence: 0.8 })).column, 'keep');
  const low = decide(state, reading({ 0: 0.8, 1: 0.1, 2: 0.05, 3: 0.05 }, { confidence: DEFAULT_TAU - 0.01 }));
  assert.equal(low.column, 'unsure');
  assert.match(low.reason, /^confidence .* below /);
});

test('confidence exactly at the gate still decides', () => {
  const d = decide(state, reading({ 0: 0.7, 1: 0.2, 2: 0.05, 3: 0.05 }, { confidence: DEFAULT_TAU }));
  assert.equal(d.column, 'delete');
});

test('an unrecognized level is not a delete', () => {
  const d = decide(state, { mode: 'keep', confidence: 0.95 });
  assert.equal(d.column, 'unsure');
  assert.equal(d.reason, 'no unique level');
  const missing = decide(state, { confidence: 0.95 });
  assert.equal(missing.column, 'unsure');
});

test('numeric-string confidence does not throw and still gates', () => {
  assert.equal(decide(state, { mode: '3', confidence: '0.95', dist: { 0: 0, 1: 0, 2: 0.05, 3: 0.95 } }).column, 'keep');
  assert.equal(decide(state, { mode: '0', confidence: '0.10' }).column, 'unsure');
});

test('a hard rule still wins over a tied model reading', () => {
  const { state: fav } = makeState('fav', { isFavorite: true });
  const d = decide(fav, reading({ 0: 0.5, 1: 0, 2: 0, 3: 0.5 }));
  assert.equal(d.column, 'keep');
  assert.equal(d.by, 'rule');
});

test('recorded junk runs do not change column when their distribution is supplied', () => {
  // The bank's real ties are either inside one column or already mode "2".
  // Supplying dist must not move those historical decisions; a future delete/keep tie must.
  const fs = require('node:fs');
  const path = require('node:path');
  const { records } = require('./items');
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  for (const file of ['results.json', 'results-profile-aggressive.json']) {
    const saved = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    for (const it of saved.results) {
      if (it.qkey !== 'junk') continue;
      const rec = byId[it.rec];
      assert.ok(rec, it.rec);
      for (const run of it.runs) {
        if (run.error) continue;
        const before = decide(rec.state, { mode: run.mode, confidence: run.confidence });
        const after = decide(rec.state, { mode: run.mode, confidence: run.confidence, dist: run.dist });
        assert.equal(after.column, before.column, `${file} ${it.id} mode ${run.mode} dist ${JSON.stringify(run.dist)}`);
      }
    }
  }
});
