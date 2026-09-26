// 把 items.js 里的问题原样导出成 Swift（iOS app 用），保证手机上发的指令和题库一字不差、键序一致。
//   node tools/capability/export-questions.js   # 写 ios/JevPhoto/JevPhoto/Model/Questions.swift
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
const out = `// 由 tools/capability/export-questions.js 从 items.js 生成，不要手改。
// 指令、criteria 和键序与 A 方案题库一字不差（序列化顺序是 prompt 的一部分）。
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
console.log(`写入 ${path.relative(process.cwd(), dest)}（${QKEYS.length} 问）`);
