#!/usr/bin/env node
// Validates seed/*.json (BANK-3). The seed files are the bank's source of truth (BANK-4); they
// are exported from the app or edited by hand. Checks, per file:
//   - JSON Schema (schema/track.schema.json);
//   - the file is named <trackId>.json and track ids are unique across files;
//   - category ids are unique and start with "<trackId>-"; every category is used by a question;
//   - question ids and numbers are unique, ids are "<trackId>-<number>", every categoryId exists.
// Warnings (printed, not failures): a time estimate that differs from the BANK-5 table (BANK-10
// allows changing it), a question without five key points and four red flags (BANK-15: the bundled
// questions have five and four; the app accepts other counts), and descriptions that are still the
// placeholder from scripts/merge-descriptions.mjs. Behavioural questions have no fixed shared items:
// each covers the RUB-5 themes in its own words, which is a content review, not a check here.
//
// Usage: node scripts/validate-seed.mjs [seedDir]
// Exits non-zero with readable messages on any failure.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = join(ROOT, 'seed');
const PLACEHOLDER_RE = /^PLACEHOLDER:/;
const TIME_MIN = {
  knowledge: { core: 3, advanced: 4, expert: 5 },
  scenario: { core: 5, advanced: 5, expert: 6 },
  design: { core: 7, advanced: 7, expert: 8 },
  behavioural: { core: 4 },
};
/** BANK-15: the bundled questions have five key points and four red flags each. */
const KEY_POINTS = 5;
const RED_FLAGS = 4;
const TYPES = ['knowledge', 'scenario', 'design', 'behavioural'];
const DIFFICULTIES = ['core', 'advanced', 'expert'];

const seedDir = process.argv[2] ? resolve(process.argv[2]) : SEED_DIR;
const rel = (p) => {
  const r = relative(ROOT, p);
  return r && !r.startsWith('..') ? r : p;
};

const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'track.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

if (!existsSync(seedDir)) {
  console.error(`validate:seed failed: ${rel(seedDir)} does not exist`);
  process.exit(1);
}

const fileNames = readdirSync(seedDir)
  .filter((f) => f.endsWith('.json'))
  .sort();
if (!fileNames.length) errors.push(`${rel(seedDir)}: no track files (*.json)`);
const tracks = [];

for (const name of fileNames) {
  const file = rel(join(seedDir, name));
  let data;
  try {
    data = JSON.parse(readFileSync(join(seedDir, name), 'utf8'));
  } catch (err) {
    fail(file, `cannot read/parse JSON: ${err.message}`);
    continue;
  }
  if (!validate(data)) {
    for (const e of validate.errors) {
      const extra = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
      fail(file, `schema: ${e.instancePath || '/'} ${e.message}${extra}`);
    }
    continue; // semantic checks assume the shape is right
  }
  tracks.push({ name, file, data });
}

// --- Semantic checks -------------------------------------------------------
const trackFiles = new Map();
let placeholders = 0;
for (const { name, file, data } of tracks) {
  const tid = data.track.id;
  if (name !== `${tid}.json`) fail(file, `file name should be ${tid}.json for track id "${tid}"`);
  if (trackFiles.has(tid)) fail(file, `track id "${tid}" is also used by ${trackFiles.get(tid)}`);
  else trackFiles.set(tid, file);

  const catIds = new Set();
  for (const c of data.categories) {
    if (catIds.has(c.id)) fail(file, `duplicate category id ${c.id}`);
    catIds.add(c.id);
    if (!c.id.startsWith(`${tid}-`)) fail(file, `category ${c.id} must start with "${tid}-"`);
  }

  const ids = new Set();
  const numbers = new Set();
  const used = new Set();
  for (const q of data.questions) {
    const where = `${file} ${q.id}`;
    if (ids.has(q.id)) fail(file, `duplicate question id ${q.id}`);
    ids.add(q.id);
    if (numbers.has(q.number)) fail(file, `duplicate question number ${q.number}`);
    numbers.add(q.number);
    if (q.id !== `${tid}-${q.number}`) fail(file, `question id ${q.id} should be ${tid}-${q.number}`);
    if (!catIds.has(q.categoryId)) errors.push(`${where}: categoryId ${q.categoryId} is not a category of this track`);
    used.add(q.categoryId);
    const t = TIME_MIN[q.type]?.[q.difficulty];
    if (t !== undefined && q.timeMin !== t) warnings.push(`${where}: time estimate ${q.timeMin} min; the BANK-5 table says ${t}`);
    if (q.lookFor.length !== KEY_POINTS || q.redFlags.length !== RED_FLAGS) {
      warnings.push(`${where}: ${q.lookFor.length} key point(s) and ${q.redFlags.length} red flag(s); the bundled questions have ${KEY_POINTS} and ${RED_FLAGS} (BANK-15)`);
    }
    if (PLACEHOLDER_RE.test(q.description)) placeholders++;
  }
  for (const c of data.categories) {
    if (!used.has(c.id)) fail(file, `category ${c.id} has no questions`);
  }
}
if (placeholders) warnings.push(`${placeholders} question(s) still have the placeholder description; run node scripts/merge-descriptions.mjs`);

// --- Summary ---------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('track', 8) + pad('version', 11) + pad('cats', 6) + pad('qs', 5) + pad('active', 8) +
    TYPES.map((t) => pad(t.slice(0, 5), 7)).join('') +
    DIFFICULTIES.map((d) => pad(d.slice(0, 5), 7)).join('') + 'minutes',
);
let total = 0;
for (const { data } of tracks) {
  const qs = data.questions;
  total += qs.length;
  const byType = TYPES.map((t) => qs.filter((q) => q.type === t).length);
  const byDiff = DIFFICULTIES.map((d) => qs.filter((q) => q.difficulty === d).length);
  const minutes = qs.reduce((n, q) => n + q.timeMin, 0);
  console.log(
    pad(data.track.id, 8) + pad(data.track.version, 11) + pad(data.categories.length, 6) + pad(qs.length, 5) +
      pad(qs.filter((q) => q.status === 'active').length, 8) +
      byType.map((n) => pad(n, 7)).join('') + byDiff.map((n) => pad(n, 7)).join('') + minutes,
  );
}
console.log(`total: ${total} questions in ${tracks.length} valid track file(s)`);

if (warnings.length) {
  console.warn(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  - ${w}`);
}
if (errors.length) {
  console.error(`\nvalidate:seed FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('validate:seed OK');
