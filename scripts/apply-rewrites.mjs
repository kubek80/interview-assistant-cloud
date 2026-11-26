#!/usr/bin/env node
// One-off step (November 2026, track version 2026.11.1): loads the full-sentence key points and red
// flags (BANK-15) written for spreadsheets into seed/*.json, and appends the new questions written
// with them. What it did to the bundled bank:
//   - replaced `lookFor` (five items) and `redFlags` (four items) of every question in all four
//     tracks with the rewritten wording, and raised the `version` of each question whose lists
//     changed by one (BANK-11);
//   - appended the new questions (4 for web, 3 for edge) with the next free numbers, ids
//     "<track>-<n>", the category named in the source, `timeMin` from the BANK-5 table, version 1,
//     status "active", rubricOverride null and the source's one probe;
//   - set the track `version` of each changed file to the version given (default 2026.11.1), so
//     devices reload it (BANK-6).
// Question text, descriptions and probes of existing questions are never touched. Key order and
// formatting stay those of the seed files (JSON.stringify with two spaces and a final newline, as the
// app's track export writes them). Safe to re-run: lists that already match and questions whose text
// is already in the track are left alone, and a file with nothing to change is not rewritten.
//
//   node scripts/apply-rewrites.mjs <exportDir> [trackVersion]
//
// <exportDir> holds, as handed over:
//   web-lookfor-redflags.json, qa/qa-lookfor-redflags.json, edge/edge-lookfor-redflags.json,
//   aks/aks-lookfor-redflags.json   { "<question number>": { "lookFor": [...], "redFlags": [...] } }
//   new-questions.json (web), edge/new-questions.json (edge)
//                                    [{ text, description, type, difficulty, category, lookFor, redFlags, probe }]
// Run `npm run validate:seed` afterwards.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = join(ROOT, 'seed');
const TIME_MIN = {
  knowledge: { core: 3, advanced: 4, expert: 5 },
  scenario: { core: 5, advanced: 5, expert: 6 },
  design: { core: 7, advanced: 7, expert: 8 },
  behavioural: { core: 4 },
};
const SOURCES = {
  web: { lists: 'web-lookfor-redflags.json', added: 'new-questions.json' },
  qa: { lists: 'qa/qa-lookfor-redflags.json' },
  edge: { lists: 'edge/edge-lookfor-redflags.json', added: 'edge/new-questions.json' },
  aks: { lists: 'aks/aks-lookfor-redflags.json' },
};

const [dirArg, versionArg = '2026.11.1'] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/apply-rewrites.mjs <exportDir> [trackVersion]');
  process.exit(1);
}
if (!/^[0-9]{4}\.(0[1-9]|1[0-2])(\.[1-9][0-9]*)?$/.test(versionArg)) {
  console.error(`apply-rewrites: "${versionArg}" is not a track version (year.month with an optional release number)`);
  process.exit(1);
}
const exportDir = resolve(dirArg);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const strings = (v, n) => Array.isArray(v) && v.length === n && v.every((s) => typeof s === 'string' && s.trim());
const same = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const problems = [];
const writes = [];

for (const [trackId, src] of Object.entries(SOURCES)) {
  const seedPath = join(SEED_DIR, `${trackId}.json`);
  const data = readJson(seedPath);
  const lists = readJson(join(exportDir, src.lists));
  let changed = 0;
  let added = 0;

  const byNumber = new Map(data.questions.map((q) => [q.number, q]));
  for (const [num, entry] of Object.entries(lists)) {
    const q = byNumber.get(Number(num));
    if (!q) {
      problems.push(`${trackId}: no question number ${num}`);
      continue;
    }
    if (!strings(entry.lookFor, 5) || !strings(entry.redFlags, 4)) {
      problems.push(`${trackId} ${num}: expected five key points and four red flags`);
      continue;
    }
    if (same(q.lookFor, entry.lookFor) && same(q.redFlags, entry.redFlags)) continue;
    q.lookFor = [...entry.lookFor];
    q.redFlags = [...entry.redFlags];
    q.version += 1; // BANK-11
    changed++;
  }
  const addedTexts = new Set(src.added && existsSync(join(exportDir, src.added)) ? readJson(join(exportDir, src.added)).map((n) => n.text) : []);
  const missing = data.questions.filter((q) => !(String(q.number) in lists) && !addedTexts.has(q.text)).map((q) => q.number);
  if (missing.length) problems.push(`${trackId}: no rewritten lists for question(s) ${missing.join(', ')}`);

  if (src.added && existsSync(join(exportDir, src.added))) {
    const catByName = new Map(data.categories.map((c) => [c.name, c.id]));
    const texts = new Set(data.questions.map((q) => q.text));
    let next = Math.max(...data.questions.map((q) => q.number)) + 1;
    for (const n of readJson(join(exportDir, src.added))) {
      if (texts.has(n.text)) continue; // already added on an earlier run
      const categoryId = catByName.get(n.category);
      const timeMin = TIME_MIN[n.type]?.[n.difficulty];
      if (!categoryId || timeMin === undefined || !strings(n.lookFor, 5) || !strings(n.redFlags, 4) || typeof n.probe !== 'string') {
        problems.push(`${trackId}: new question "${n.text.slice(0, 40)}…" has an unknown category, type/difficulty, or incomplete lists`);
        continue;
      }
      const number = next++;
      // The documented key order of a seed question (docs/05-question-bank.md).
      data.questions.push({
        id: `${trackId}-${number}`,
        number,
        categoryId,
        text: n.text,
        description: n.description,
        difficulty: n.difficulty,
        type: n.type,
        timeMin,
        lookFor: [...n.lookFor],
        redFlags: [...n.redFlags],
        probes: [n.probe],
        version: 1,
        status: 'active',
        rubricOverride: null,
      });
      added++;
    }
  }

  if (changed || added) {
    data.track.version = versionArg;
    writes.push([seedPath, JSON.stringify(data, null, 2) + '\n']);
  }
  console.log(`seed/${trackId}.json: ${changed} question(s) with new lists, ${added} added, ${data.questions.length} in all, track version ${data.track.version}`);
}

if (problems.length) {
  console.error(`\napply-rewrites: ${problems.length} problem(s); nothing was written:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const [path, text] of writes) writeFileSync(path, text);
console.log('Run npm run validate:seed next.');
