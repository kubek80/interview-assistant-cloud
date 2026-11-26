// Keeps docs/10-verification.md in step with the specification (docs 01-09, 11 and 12) and with the tests.
// It fails when:
//   - a requirement id defined in docs 01-09, 11 or 12 has no row in docs/10-verification.md;
//   - docs/10-verification.md names an id that is not defined any more;
//   - a row cites an automated test file that does not exist, or that has no test title
//     mentioning that row's id.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const ID = /[A-Z][A-Z0-9]*-\d+/;

/** Ids defined in docs 01-09: inline code at the start of a list item. */
export function definedIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\s*[-*]\s+`([A-Z][A-Z0-9]*-\d+)`/gm)].map((m) => m[1]);
}

export interface VerificationRow {
  id: string;
  /** Test files cited in the row, as repository paths (src/... or e2e/...). */
  files: string[];
  line: number;
}

/** Table rows of docs/10-verification.md whose first cell is a requirement id in inline code. */
export function verificationRows(markdown: string): VerificationRow[] {
  const rows: VerificationRow[] = [];
  markdown.split('\n').forEach((line, i) => {
    const m = /^\|\s*`([A-Z][A-Z0-9]*-\d+)`\s*\|/.exec(line);
    if (!m) return;
    const files = [...line.matchAll(/`((?:src|e2e)\/[\w./-]+\.(?:test|spec)\.tsx?)`/g)].map((f) => f[1]);
    rows.push({ id: m[1], files: [...new Set(files)], line: i + 1 });
  });
  return rows;
}

/** Test titles in a Vitest or Playwright file (it/test/describe first string argument). */
export function testTitles(source: string): string[] {
  return [...source.matchAll(/\b(?:it|test)(?:\.(?:only|skip|fixme))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gs)].map((m) => m[2]);
}

/** Every docs page except the verification page itself (10). */
const specPages = readdirSync(DOCS)
  .filter((f) => /^\d\d-.*\.md$/.test(f) && !f.startsWith('10-'))
  .sort();

/**
 * Requirements specified but not built yet. Their rows say "Not built yet" instead of citing tests.
 * Keep this list short and current: whoever builds one of these removes it from the list and gives
 * its row real tests (the test below fails while a built id is still listed with that status, and
 * fails for any other id marked "Not built yet").
 */
const NOT_BUILT_YET: readonly string[] = [];
const defined = new Map<string, string>();
for (const f of specPages) for (const id of definedIds(readFileSync(join(DOCS, f), 'utf8'))) defined.set(id, f);
const verification = readFileSync(join(DOCS, '10-verification.md'), 'utf8');
const rows = verificationRows(verification);

describe('traceability: docs/10-verification.md', () => {
  it('OV-3: finds the requirement ids in docs 01-09, 11 and 12 and the rows of the verification page', () => {
    expect(specPages).toHaveLength(11);
    expect(specPages).toContain('11-interviewers-transcripts-ai.md');
    expect(specPages).toContain('12-planning-and-panels.md');
    expect(defined.get('TEAM-1')).toBe('12-planning-and-panels.md');
    expect(defined.has('PANEL-1')).toBe(true);
    expect(NOT_BUILT_YET.filter((id) => !defined.has(id)), 'NOT_BUILT_YET names ids the docs do not define').toEqual([]);
    expect(defined.size).toBeGreaterThan(80);
    expect(rows.length).toBeGreaterThan(80);
  });

  it('every requirement id defined in docs 01-09, 11 and 12 has exactly one row', () => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    const missing = [...defined.keys()].filter((id) => !counts.has(id));
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
    expect(missing, 'ids without a row in docs/10-verification.md').toEqual([]);
    expect(duplicated, 'ids with more than one row').toEqual([]);
  });

  it('the verification page names no id that the specification does not define', () => {
    const mentioned = new Set([...verification.matchAll(new RegExp(`\`(${ID.source})\``, 'g'))].map((m) => m[1]));
    const unknown = [...mentioned].filter((id) => !defined.has(id));
    expect(unknown, 'ids in docs/10-verification.md that docs 01-09, 11 and 12 do not define').toEqual([]);
  });

  it('every cited test file exists and has a test title mentioning the row’s id', () => {
    const problems: string[] = [];
    const cache = new Map<string, string[] | null>();
    for (const row of rows) {
      for (const file of row.files) {
        if (!cache.has(file)) {
          const path = join(ROOT, file);
          cache.set(file, existsSync(path) ? testTitles(readFileSync(path, 'utf8')) : null);
        }
        const titles = cache.get(file);
        const mentions = new RegExp(`(^|[^A-Z0-9-])${row.id}(?![0-9])`);
        if (titles === null) problems.push(`line ${row.line}: ${row.id} cites ${file}, which does not exist`);
        else if (!titles!.some((t) => mentions.test(t))) problems.push(`line ${row.line}: ${row.id} cites ${file}, which has no test title mentioning ${row.id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a row marked automated cites at least one test file; other rows say what remains manual; only listed ids are not built yet', () => {
    const bad: string[] = [];
    for (const line of verification.split('\n')) {
      const m = /^\|\s*`([A-Z][A-Z0-9]*-\d+)`\s*\|/.exec(line);
      if (!m) continue;
      const cells = line.split('|').map((c) => c.trim());
      const status = cells[cells.length - 2] ?? '';
      const how = cells.slice(3, -2).join(' ');
      const listed = NOT_BUILT_YET.includes(m[1]);
      if (/^Not built yet/.test(status)) {
        if (!listed) bad.push(`${m[1]}: "Not built yet" is allowed only for ids on the NOT_BUILT_YET list in this test`);
        continue;
      }
      if (listed) bad.push(`${m[1]}: built now? Remove it from NOT_BUILT_YET (its row is "${status}")`);
      if (!/^(Automated|Partial|Manual)/.test(status)) bad.push(`${m[1]}: status "${status}" must start with Automated, Partial or Manual`);
      if (/^Automated/.test(status) && !/`(src|e2e|scripts)\//.test(how)) bad.push(`${m[1]}: automated but cites no test or script`);
      if (/^(Partial|Manual)/.test(status) && !/manual/i.test(how + status)) bad.push(`${m[1]}: partial/manual rows must say what is checked by hand`);
    }
    expect(bad).toEqual([]);
  });
});

describe('traceability helpers', () => {
  it('parses ids, rows and test titles', () => {
    expect(definedIds('- `FLOW-1` A\n  - `X-2` b\ntext `FLOW-3`')).toEqual(['FLOW-1', 'X-2']);
    expect(verificationRows('| `A-1` | x | `src/a.test.ts` “t”, `e2e/b.spec.ts` | Automated |')).toEqual([
      { id: 'A-1', files: ['src/a.test.ts', 'e2e/b.spec.ts'], line: 1 },
    ]);
    expect(testTitles("it('A-1: x', () => {}); test(`B-2 y`, async () => {}); test.describe('C-3', () => {})")).toEqual(['A-1: x', 'B-2 y']);
  });
});
