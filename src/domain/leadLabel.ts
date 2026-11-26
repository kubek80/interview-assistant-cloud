// BANK-15: a key point or red flag is often written as "Short label: what you would hear". The
// label is emphasised in the live interview (and the other read-only lists) so a list of sentences
// can be scanned at a glance. This module decides, conservatively, whether an item has such a label.

/** Longest label that is emphasised, in words and characters. Longer text before a colon is a sentence. */
export const LEAD_LABEL_MAX_WORDS = 6;
export const LEAD_LABEL_MAX_CHARS = 48;

/**
 * Characters a label may contain: letters, digits, spaces, hyphens, commas followed by a space,
 * apostrophes after a letter, "&", "/", "+" and balanced parentheses after a space. Anything else
 * (dots of "e.g." or code, quotes, "=", square or curly brackets…) means the colon is probably inside running text or code, so
 * nothing is emphasised.
 */
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’&/+(),-]*$/u;
/** Words that introduce a list rather than end a label ("such as: a, b"). */
const LIST_INTRO_RE = /\b(?:such as|including|like|namely|for example|for instance|as follows)$/i;

export interface LeadLabel {
  /** The label with its colon, exactly as written ("Mitigation first:"). */
  lead: string;
  /** Everything after the colon, including the space that follows it, exactly as written. */
  rest: string;
}

/**
 * BANK-15: splits "Short label: what you would hear" into the label (with its colon) and the rest,
 * so that `lead + rest` is the original text. Returns null when the item has no clear leading
 * label: no colon; the first colon not followed by a space ("https://", "2:30", "Top 10:2025");
 * more than six words or 48 characters before it; characters before it that suggest running text
 * or code ("e.g.", "azure.workload.identity/use", quotes, commas); a list introduction ("such as:");
 * or nothing after it. When in doubt, no emphasis.
 */
export function leadLabel(text: string): LeadLabel | null {
  const i = text.indexOf(':');
  if (i <= 0) return null;
  if (!/^\s/.test(text.slice(i + 1, i + 2))) return null;
  const label = text.slice(0, i);
  if (label !== label.trimStart() || /\s$/.test(label)) return null;
  if (label.length > LEAD_LABEL_MAX_CHARS) return null;
  if (label.split(/\s+/).length > LEAD_LABEL_MAX_WORDS) return null;
  if (!LABEL_RE.test(label) || !balanced(label) || LIST_INTRO_RE.test(label)) return null;
  // Code-like: a bracket straight after a word ("getByRole("), a quote mark rather than an apostrophe.
  if (/[^\s]\(/.test(label) || /,(?! )/.test(label) || /(^|[^\p{L}])['’]/u.test(label)) return null;
  const rest = text.slice(i + 1);
  if (rest.trim().length < 2) return null;
  return { lead: text.slice(0, i + 1), rest };
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
