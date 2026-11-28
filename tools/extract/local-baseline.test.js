// Mac reviews skip screenshots from the last 14 days. Comparing them with the phone's
// 3-day window reports those screenshots as disagreements.
//   node --test tools/extract/local-baseline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeState } = require('../capability/items');
const { decide, RECENT_SCREENSHOT_DAYS } = require('../capability/rules');
const { localDecide, recentWindow } = require('./local-baseline');

function screenshot(days) {
  const { state } = makeState(`shot-${days}d`, {
    mediaSubtypes: ['photoScreenshot'], pixelWidth: 1179, pixelHeight: 2556, hasLocation: false,
    contentType: 'public.png', dataSize: 1_400_000,
    Make: null, Model: null, LensModel: null, ISOSpeedRatings: null, ExposureTime: null, FNumber: null,
    overallScore: -0.8, isUtility: true, sharpness: 0.98, meanLuminance: 0.85,
    recognizedTextCharCount: 400, daysSinceCreation: days,
  });
  return state;
}

function run(script, args) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
}

test('a 10-day screenshot is kept by the Mac rule and deleted by the 3-day window', () => {
  const state = screenshot(10);
  assert.equal(decide(state, null).column, 'keep');
  assert.equal(localDecide(state, RECENT_SCREENSHOT_DAYS).column, 'keep');
  assert.equal(localDecide(state, 3).column, 'delete');
  assert.equal(recentWindow({ mode: 'folder' }), RECENT_SCREENSHOT_DAYS);
  assert.equal(recentWindow({ mode: 'iphone' }), 3);
  assert.equal(recentWindow({ mode: 'folder', recentScreenshotDays: 3 }), 3);
  assert.equal(recentWindow({ mode: 'iphone', recentScreenshotDays: 14 }), 14);
  assert.equal(recentWindow({ mode: 'folder', recentScreenshotDays: null }), RECENT_SCREENSHOT_DAYS);
});

test('a Mac dry run records the 14-day window, so a 10-day screenshot is not a disagreement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ask-'));
  try {
    const state = screenshot(10);
    fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({
      generatedAt: '2026-09-21T12:00:00Z', mode: 'folder', source: dir,
      records: [{ id: 'shot-10d', file: 'shot.png', thumbnail: null, dates: {}, state }],
    }));
    const ask = run('ask.js', [dir]);
    assert.equal(ask.status, 0, ask.stderr);
    const decisions = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'));
    assert.equal(decisions.mode, 'folder');
    assert.equal(decisions.recentScreenshotDays, RECENT_SCREENSHOT_DAYS);
    assert.equal(decisions.decisions[0].decision.column, 'keep');
    assert.match(fs.readFileSync(path.join(dir, 'review.html'), 'utf8'), /last 14 days/);

    const cmp = run('local-baseline.js', [path.join(dir, 'decisions.json')]);
    assert.equal(cmp.status, 0, cmp.stderr);
    assert.match(cmp.stdout, /1 images/);
    assert.match(cmp.stdout, /0 disagreements/);

    // The previous fallback treated a missing or aggressive window as 3 days and deleted this screenshot.
    const legacy = { ...decisions };
    delete legacy.recentScreenshotDays;
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(legacy));
    const oldFile = run('local-baseline.js', [path.join(dir, 'legacy.json')]);
    assert.match(oldFile.stdout, /0 disagreements/);

    decisions.recentScreenshotDays = 3;
    fs.writeFileSync(path.join(dir, 'forced.json'), JSON.stringify(decisions));
    const forced = run('local-baseline.js', [path.join(dir, 'forced.json')]);
    assert.match(forced.stdout, /1 disagreements/);
    assert.match(forced.stdout, /local delete \(screenshot \/ saved image older than a week\)/);
    assert.match(forced.stdout, /Jev keep \(screenshot from the last 14 days\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an iPhone export without the field still uses the aggressive 3-day window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-phone-'));
  try {
    const state = screenshot(10);
    const file = path.join(dir, 'decisions.json');
    fs.writeFileSync(file, JSON.stringify({
      mode: 'iphone',
      records: [{ id: 'shot-10d', state, decision: { column: 'delete', by: 'jev', reason: 'probably delete, confidence 0.80' } }],
    }));
    const cmp = run('local-baseline.js', [file]);
    assert.equal(cmp.status, 0, cmp.stderr);
    assert.match(cmp.stdout, /0 disagreements/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
