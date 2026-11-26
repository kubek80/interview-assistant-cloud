// Delimited-text parser (RFC 4180 rules) for CSV files and tab-separated rows pasted from a
// spreadsheet (BANK-13). Pure. Writing CSV is in export.ts (csvCell / toCsv).

/**
 * Parses `text` into rows of cells. Handles quoted cells with embedded delimiters, doubled quotes
 * and line breaks, CRLF/LF/CR line ends, a byte-order mark and a missing final line break. Rows that
 * are completely empty are dropped.
 */
export function parseDelimited(text: string, delimiter: ',' | '\t' | ';' = ','): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      // An opening quote (spaces before it are dropped, as spreadsheets do).
      quoted = true;
      cell = '';
      i++;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** Tab when the first line has a tab (rows pasted from a spreadsheet), otherwise comma. */
export function detectDelimiter(text: string): ',' | '\t' {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  return first.includes('\t') ? '\t' : ',';
}
