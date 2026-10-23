// Export the questions in items.js verbatim to Swift for the iOS app, so the phone sends exactly the same
// instructions as the bank, with the same key order.
//   node tools/capability/export-questions.js   # writes ios/JevPhoto/JevPhoto/Model/Questions.swift
const fs = require('node:fs');
const path = require('node:path');
const { QUESTIONS, QKEYS, PROFILES } = require('./items');

const lit = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
const toSwift = (v) => {
  if (Array.isArray(v)) return `.arr([${v.map(toSwift).join(', ')}])`;
  if (v && typeof v === 'object') return `.obj([${Object.entries(v).map(([k, x]) => `(${lit(k)}, ${toSwift(x)})`).join(', ')}])`;
  if (typeof v === 'string') return `.s(${lit(v)})`;
  if (typeof v === 'number') return Number.isInteger(v) ? `.i(${v})` : `.d(${v})`;
  if (typeof v === 'boolean') return `.b(${v})`;
  return '.null';
};
const out = `// Generated from items.js by tools/capability/export-questions.js. Do not edit by hand.
// Instructions, criteria and key order match the phase A bank exactly (serialization order is part of the prompt).
import Foundation

let QUESTION_KEYS: [String] = [${QKEYS.map(lit).join(', ')}]
let QUESTIONS: J = ${toSwift(QUESTIONS)}
let QUESTIONS_AGGRESSIVE: J = ${toSwift(PROFILES.aggressive.questions)}
let PROFILE_AGGRESSIVE_RECENT_DAYS = ${PROFILES.aggressive.recentScreenshotDays}
let PROFILE_AGGRESSIVE_TAU = ${PROFILES.aggressive.tau}
let JUNK_LEVELS: [String] = [${QUESTIONS.junk.criteria.map(lit).join(', ')}]
let KIND_KEYS: [String] = [${Object.keys(QUESTIONS.kind.criteria).map(lit).join(', ')}]
let KIND_LABELS: [String: String] = [${Object.entries(QUESTIONS.kind.criteria).map(([k, v]) => `${lit(k)}: ${lit(v)}`).join(', ')}]
`;
const dest = path.join(__dirname, '..', '..', 'ios', 'JevPhoto', 'JevPhoto', 'Model', 'Questions.swift');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`Wrote ${path.relative(process.cwd(), dest)} (${QKEYS.length} questions)`);
