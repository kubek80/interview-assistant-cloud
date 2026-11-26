// BANK-13: many questions at once, from rows pasted from a spreadsheet or a CSV file, and a track
// exported as CSV in the same layout. Pure: the repository creates the questions.
import { toCsv } from './export';
import { detectDelimiter, parseDelimited } from './csv';
import { LIMITS, cleanList, defaultTimeMin, normaliseDraft, slugify, validateQuestionDraft, type QuestionDraft } from './bankEdit';
import { DIFFICULTIES, QUESTION_TYPES, type Category, type Difficulty, type Question, type QuestionType } from './types';

export type CsvColumn = 'text' | 'description' | 'category' | 'difficulty' | 'type' | 'lookFor' | 'redFlags' | 'probes' | 'timeMin';

/** Column order of the template, the export and header-less input. */
export const CSV_COLUMNS: readonly CsvColumn[] = ['text', 'description', 'category', 'difficulty', 'type', 'lookFor', 'redFlags', 'probes', 'timeMin'];

export const CSV_HEADERS: Record<CsvColumn, string> = {
  text: 'Question',
  description: 'Description',
  category: 'Category',
  difficulty: 'Difficulty',
  type: 'Type',
  lookFor: 'Key points',
  redFlags: 'Red flags',
  probes: 'Probes',
  timeMin: 'Time (min)',
};

/** Header names accepted for each column (compared lower-case, without punctuation). */
const ALIASES: Record<CsvColumn, string[]> = {
  text: ['question', 'text', 'question text'],
  description: ['description', 'steer', 'steering', 'explanation'],
  category: ['category', 'category id', 'categoryid'],
  difficulty: ['difficulty', 'level'],
  type: ['type', 'question type'],
  lookFor: ['key points', 'keypoints', 'look for', 'lookfor', 'l', 'what to look for'],
  redFlags: ['red flags', 'redflags', 'r', 'red flag'],
  probes: ['probes', 'probe', 'p', 'follow up', 'follow ups', 'follow-up'],
  timeMin: ['time min', 'time', 'minutes', 'time estimate', 'timemin', 'time minutes', 'estimate'],
};

const headerKey = (s: string) => s.toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9-]+/g, ' ').trim();

function columnFor(header: string): CsvColumn | null {
  const k = headerKey(header);
  for (const c of CSV_COLUMNS) if (ALIASES[c].includes(k)) return c;
  return null;
}

/**
 * Maps a first row to columns when it is a header row (at least two cells name known columns,
 * including the question text). Returns null when the first row is data.
 */
export function headerColumns(row: readonly string[]): Array<CsvColumn | null> | null {
  const cols = row.map(columnFor);
  const known = cols.filter(Boolean);
  if (known.length < 2 || !cols.includes('text')) return null;
  return cols;
}

/** Splits a list cell: by line breaks when it has any, otherwise by semicolons. */
export function splitListCell(cell: string): string[] {
  return cleanList(/[\r\n]/.test(cell) ? cell.split(/\r\n|\r|\n/) : cell.split(';'));
}

/** Joins a list for a cell so that splitListCell gives it back (line breaks; never ambiguous). */
export function joinListCell(items: readonly string[]): string {
  const joined = items.join('\n');
  // A single item containing ";" would be split on import: a trailing line break keeps it whole.
  return items.length === 1 && items[0].includes(';') ? `${joined}\n` : joined;
}

/** Removes the apostrophe that csvCell puts before text a spreadsheet would read as a formula. */
function unneutralise(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

function parseDifficulty(s: string): Difficulty | null {
  const k = s.trim().toLowerCase();
  if (!k) return null;
  return DIFFICULTIES.find((d) => d === k || d[0] === k) ?? null;
}

function parseType(s: string): QuestionType | null {
  const k = s.trim().toLowerCase().replace(/behavioral/, 'behavioural');
  if (!k) return null;
  return QUESTION_TYPES.find((t) => t === k || t[0] === k) ?? null;
}

export interface BulkRow {
  /** 1-based row number in the pasted text or file (the header row counts). */
  line: number;
  draft: QuestionDraft;
  /** The category as written, when it names no existing category (offered to be created). */
  newCategory: string | null;
  problems: string[];
}

export interface BulkParse {
  rows: BulkRow[];
  /** True when the first row was recognised as a header and matched by name. */
  header: boolean;
  /** Header cells that match no column (ignored). */
  ignoredColumns: string[];
  /** New category names in first-seen order. */
  newCategories: string[];
  /** A problem with the input as a whole (nothing to import, unreadable). */
  problem: string | null;
}

export const MAX_BULK_ROWS = 500;

/**
 * BANK-13: parses pasted or uploaded rows into question drafts with per-row problems. Columns are
 * matched by header name when the first row is a header, otherwise taken in CSV_COLUMNS order.
 * Categories match by name or id (ignoring case); an unknown one is reported as a new category.
 * Key points and red flags are imported as written (behavioural rows too: RUB-5 has no shared
 * items, each question covers its themes in its own words); an empty difficulty is core for
 * behavioural questions; an empty time is filled in from BANK-5.
 */
export function parseBulkQuestions(
  text: string,
  trackId: string,
  categories: readonly Pick<Category, 'id' | 'name'>[],
  existingTexts: readonly string[] = [],
): BulkParse {
  const empty = (problem: string): BulkParse => ({ rows: [], header: false, ignoredColumns: [], newCategories: [], problem });
  if (!text.trim()) return empty('Paste some rows or choose a file first.');
  let delimiter: ',' | '\t' | ';' = detectDelimiter(text);
  let table = parseDelimited(text, delimiter);
  let cols = table.length ? headerColumns(table[0]) : null;
  if (!cols && delimiter === ',') {
    // A semicolon-separated CSV (some spreadsheet locales) is recognised by its header row.
    const alt = parseDelimited(text, ';');
    const altCols = alt.length ? headerColumns(alt[0]) : null;
    if (altCols) {
      delimiter = ';';
      table = alt;
      cols = altCols;
    }
  }
  if (!table.length) return empty('There are no rows to import.');
  const header = cols !== null;
  const columns: Array<CsvColumn | null> = cols ?? [...CSV_COLUMNS];
  const ignoredColumns = header ? table[0].filter((_, i) => columns[i] === null).map((s) => s.trim()).filter(Boolean) : [];
  const body = header ? table.slice(1) : table;
  if (!body.length) return { ...empty('There are no question rows under the header row.'), header };
  if (body.length > MAX_BULK_ROWS) return { ...empty(`At most ${MAX_BULK_ROWS} rows can be added at once; this has ${body.length}.`), header };

  const byName = new Map<string, string>();
  for (const c of categories) {
    byName.set(c.name.trim().toLowerCase(), c.id);
    byName.set(c.id.toLowerCase(), c.id);
  }
  const newCategories: string[] = [];
  const newIds = new Map<string, string>(); // lower-case name → provisional id

  const rows: BulkRow[] = body.map((cells, i) => {
    const raw = (c: CsvColumn) => {
      const idx = columns.indexOf(c);
      return idx >= 0 ? (cells[idx] ?? '') : '';
    };
    const get = (c: CsvColumn) => unneutralise(raw(c).trim());
    // List cells are split before trimming: a trailing line break marks a one-item list.
    const list = (c: CsvColumn) => splitListCell(unneutralise(raw(c).replace(/^[ \t]+/, '')));
    const problems: string[] = [];
    const extra = cells.slice(columns.length).filter((c) => c.trim());
    if (!header && extra.length) problems.push(`Has ${cells.length} columns; expected ${CSV_COLUMNS.length}.`);

    const typeText = get('type');
    const type = parseType(typeText);
    if (!type) problems.push(typeText ? `Unknown type “${typeText}”: use knowledge, scenario, design or behavioural.` : 'Type is missing.');
    const diffText = get('difficulty');
    let difficulty = parseDifficulty(diffText);
    if (!difficulty) {
      if (type === 'behavioural' && !diffText) difficulty = 'core';
      else problems.push(diffText ? `Unknown difficulty “${diffText}”: use core, advanced or expert.` : 'Difficulty is missing.');
    }
    if (type === 'behavioural' && difficulty && difficulty !== 'core') problems.push('Behavioural questions are always core.');

    const catText = get('category');
    let categoryId = '';
    let newCategory: string | null = null;
    if (!catText) problems.push('Category is missing.');
    else {
      const key = catText.toLowerCase();
      const found = byName.get(key);
      if (found) categoryId = found;
      else {
        newCategory = catText;
        if (!newIds.has(key)) {
          newIds.set(key, `${trackId}-${slugify(catText) || 'category'}`);
          newCategories.push(catText);
        }
        categoryId = newIds.get(key)!;
      }
    }

    const timeText = get('timeMin');
    let timeMin = type && difficulty ? defaultTimeMin(type, difficulty) : 3;
    if (timeText) {
      const n = Number(timeText.replace(/\s*min(utes)?\.?$/i, ''));
      if (Number.isInteger(n) && n >= 1 && n <= LIMITS.timeMin) timeMin = n;
      else problems.push(`Time “${timeText}” is not whole minutes from 1 to ${LIMITS.timeMin}.`);
    }

    const lookFor = list('lookFor');
    const redFlags = list('redFlags');

    const draft = normaliseDraft({
      text: get('text'),
      description: get('description'),
      categoryId,
      difficulty: difficulty ?? 'core',
      type: type ?? 'knowledge',
      timeMin,
      lookFor,
      redFlags,
      probes: list('probes'),
      rubricOverride: null,
    });
    const known = [...categories.map((c) => c.id), ...newIds.values()];
    const errors = validateQuestionDraft(draft, known);
    for (const [field, msg] of Object.entries(errors)) {
      if (field === 'categoryId' && !catText) continue; // already reported
      if ((field === 'type' && !type) || (field === 'difficulty' && !difficulty)) continue;
      problems.push(msg);
    }
    return { line: i + 1 + (header ? 1 : 0), draft, newCategory, problems };
  });

  // The same question text twice in the paste is almost certainly a mistake.
  const seen = new Map<string, number>();
  const inTrack = new Set(existingTexts.map((t) => t.trim().toLowerCase()));
  for (const r of rows) {
    const k = r.draft.text.toLowerCase();
    if (!k) continue;
    if (inTrack.has(k)) r.problems.push('This question is already in the track.');
    else if (seen.has(k)) r.problems.push(`Same question text as row ${seen.get(k)}.`);
    else seen.set(k, r.line);
  }
  return { rows, header, ignoredColumns, newCategories, problem: null };
}

/** BANK-13: the template offered for download (header plus two example rows). */
export function bulkTemplateCsv(): string {
  return toCsv([
    CSV_COLUMNS.map((c) => CSV_HEADERS[c]),
    [
      'How would you roll out a change to a shared CI pipeline safely?',
      'We want to hear how you would change something many teams depend on without breaking their builds, and how you would know it worked.',
      'CI/CD',
      'advanced',
      'scenario',
      [
        'Staged rollout: changes a few low-risk pipelines first, then widens the rollout in steps.',
        'Opt-in path: ships the change behind a feature flag or a new template version that teams adopt when ready.',
        'Metrics to watch: build success rate and duration per team, compared before and after each step.',
        'Rollback plan: can return every team to the previous version quickly, and has practised doing it.',
        'Communication: tells teams what changes, when, and where to get help before the first step.',
      ].join('\n'),
      [
        'Changes the shared pipeline for every team at once, with no way to try it on a few first.',
        'Gives no notice, so teams discover the change when their builds fail.',
      ].join('\n'),
      'What if one team’s build breaks halfway through?',
      '',
    ],
    [
      'Tell us about a time you disagreed with a technical decision.',
      'We would like a real example of a disagreement about a technical choice: what happened, what you did and how it turned out.',
      'Behavioural & leadership',
      '',
      'behavioural',
      [
        'Specific situation: names the decision, who made it and why it mattered.',
        'Own actions: made the case with evidence, such as a prototype or measurements, rather than opinion.',
        'Measurable result: says what was decided and what happened afterwards, with numbers where possible.',
        'Reflection: says what they learned and what they would do differently.',
      ].join('\n'),
      [
        'Answers hypothetically ("I would…") instead of describing a real disagreement.',
        'Blames the other people involved without looking at their own part.',
        'Cannot say how it ended or what result it had.',
      ].join('\n'),
      'What would you do differently?',
      '',
    ],
  ]);
}

/** BANK-13: a track's active questions as CSV in the bulk-add layout (round-trips through parseBulkQuestions). */
export function trackQuestionsCsv(questions: readonly Question[], categories: readonly Pick<Category, 'id' | 'name'>[]): string {
  const name = new Map(categories.map((c) => [c.id, c.name]));
  const rows = [...questions]
    .filter((q) => q.status === 'active')
    .sort((a, b) => a.number - b.number)
    .map((q) => [
      q.text,
      q.description ?? '',
      name.get(q.categoryId) ?? q.categoryId,
      q.type === 'behavioural' ? 'core' : q.difficulty,
      q.type,
      joinListCell(q.lookFor),
      joinListCell(q.redFlags),
      joinListCell(q.probes),
      q.timeMin,
    ]);
  return toCsv([CSV_COLUMNS.map((c) => CSV_HEADERS[c]), ...rows]);
}
