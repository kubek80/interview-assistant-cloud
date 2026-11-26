#!/usr/bin/env node
// One-off step: merges question descriptions (BANK-8) from content/descriptions.json into seed/*.json.
//
//   node scripts/merge-descriptions.mjs [descriptions.json]
//
// The descriptions file maps question id to description: { "aks-11": "We want to hear…", … }.
// Every question named in it gets that description. A question that still has no description
// gets the placeholder below, so the seed passes the schema; `npm run validate:seed` warns about
// every placeholder that is left. Safe to re-run: it only changes descriptions, keeps every other
// key and the key order, and does not change question or track versions.
//
// If a build with placeholder descriptions has already been used on a device, raise the track
// version of each changed seed (for example 2026.11 to 2026.11.1) so devices reload it (BANK-6).

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = join(ROOT, 'seed');
const source = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'content', 'descriptions.json');

/** Marks a question whose description has not been written yet. validate-seed.mjs warns on it. */
export const PLACEHOLDER = 'PLACEHOLDER: description not written yet (BANK-8).';

let descriptions = {};
if (existsSync(source)) {
  try {
    descriptions = JSON.parse(readFileSync(source, 'utf8'));
  } catch (err) {
    console.error(`merge-descriptions: cannot parse ${source}: ${err.message}`);
    process.exit(1);
  }
  if (typeof descriptions !== 'object' || descriptions === null || Array.isArray(descriptions)) {
    console.error(`merge-descriptions: ${source} must be a JSON object of question id → description`);
    process.exit(1);
  }
} else {
  console.log(`merge-descriptions: ${source} not found; filling placeholders only.`);
}

const bad = Object.entries(descriptions).filter(([, v]) => typeof v !== 'string' || !v.trim());
if (bad.length) {
  console.error(`merge-descriptions: empty or non-string descriptions for ${bad.map(([k]) => k).join(', ')}`);
  process.exit(1);
}

/** Rebuilds a question with `description` right after `text` (the documented key order). */
function withDescription(q, description) {
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    if (k === 'description') continue;
    out[k] = v;
    if (k === 'text') out.description = description;
  }
  if (!('description' in out)) out.description = description;
  return out;
}

const used = new Set();
let merged = 0;
let placeholders = 0;
for (const name of readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(SEED_DIR, name);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  let changed = 0;
  data.questions = data.questions.map((q) => {
    const given = descriptions[q.id];
    let next;
    if (typeof given === 'string') {
      used.add(q.id);
      next = given.trim();
      merged++;
    } else if (typeof q.description === 'string' && q.description.trim()) {
      next = q.description;
    } else {
      next = PLACEHOLDER;
    }
    if (next === PLACEHOLDER) placeholders++;
    if (next !== q.description) changed++;
    return withDescription(q, next);
  });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`seed/${name}: ${changed} description(s) changed`);
}

const unknown = Object.keys(descriptions).filter((id) => !used.has(id));
if (unknown.length) console.warn(`merge-descriptions: no question with id ${unknown.join(', ')} (ignored)`);
console.log(`merged ${merged} description(s); ${placeholders} placeholder(s) left. Run npm run validate:seed next.`);
