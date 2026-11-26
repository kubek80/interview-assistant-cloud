import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Transcript } from '../../domain/transcript/types';
import { Button, Icon, TextInput } from '../../ui';
import { highlightParts, pageOfLine, paginate, searchLines, transcriptLines, type ViewerLine } from './model';

export interface FocusLineRequest {
  line: number;
  /** Changes on every request, so asking for the same line twice still moves there. */
  nonce: number;
}

/**
 * TR-1: the attached transcript, read-only, with line numbers, speakers, timestamps and search.
 * Long transcripts are shown a page at a time. Clicking a timestamp seeks the recording when one
 * is attached (TR-2). Every text is rendered as React text (SEC-2).
 */
export function TranscriptViewer({ transcript, onSeek, focusLine }: { transcript: Transcript; onSeek?: (sec: number) => void; focusLine?: FocusLineRequest | null }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const lines = useMemo(() => transcriptLines(transcript), [transcript]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [highlight, setHighlight] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const shown = useMemo(() => searchLines(lines, query), [lines, query]);
  const view = paginate(shown, page);

  // AI-11: "jump to the transcript line" from a quotation.
  useEffect(() => {
    if (!focusLine) return;
    setQuery('');
    setPage(pageOfLine(focusLine.line));
    setHighlight(focusLine.line);
  }, [focusLine]);
  useEffect(() => {
    if (highlight == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-line="${highlight}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
    }
  }, [highlight, view.page]);

  const pager =
    view.pageCount > 1 ? (
      <nav className="tv-pager" aria-label={`Transcript pages${query.trim() ? ' (search results)' : ''}`}>
        <Button size="sm" icon="chevron-left" onClick={() => setPage(view.page - 1)} disabled={view.page === 0}>
          Previous
        </Button>
        <span className="small tabular">
          Lines {view.from}–{view.to} of {view.total}
        </span>
        <Button size="sm" onClick={() => setPage(view.page + 1)} disabled={view.page >= view.pageCount - 1}>
          Next <Icon name="chevron-right" />
        </Button>
      </nav>
    ) : null;

  return (
    <div className="tv">
      <div className="tv-tools" role="search">
        <label htmlFor={`${id}-search`} className="visually-hidden">
          Search the transcript
        </label>
        <TextInput
          id={`${id}-search`}
          type="search"
          placeholder="Search the transcript…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
            setHighlight(null);
          }}
          autoComplete="off"
        />
        <p className="small muted tv-count" aria-live="polite">
          {query.trim() ? `${shown.length} matching line${shown.length === 1 ? '' : 's'}` : `${lines.length} lines · ${transcript.wordCount.toLocaleString('en')} words`}
        </p>
      </div>
      {pager}
      {view.items.length ? (
        <ol ref={listRef} className="tv-lines" aria-label="Transcript lines">
          {view.items.map((l) => (
            <TranscriptLine key={l.line} line={l} query={query} onSeek={onSeek} highlighted={highlight === l.line} />
          ))}
        </ol>
      ) : (
        <p className="muted">No line matches “{query.trim()}”.</p>
      )}
      {view.pageCount > 1 && view.items.length > 20 ? pager : null}
    </div>
  );
}

function TranscriptLine({ line, query, onSeek, highlighted }: { line: ViewerLine; query: string; onSeek?: (sec: number) => void; highlighted: boolean }) {
  return (
    <li className={`tv-line${highlighted ? ' tv-line--focus' : ''}`} data-line={line.line} tabIndex={-1}>
      <span className="tv-line__no tabular" aria-label={`Line ${line.line}`}>
        {line.line}
      </span>
      <span className="tv-line__time tabular">
        {line.time ? (
          onSeek && line.startSec !== undefined ? (
            <button type="button" className="tv-seek" onClick={() => onSeek(line.startSec!)} aria-label={`Play the recording from ${line.time}`}>
              {line.time}
            </button>
          ) : (
            line.time
          )
        ) : null}
      </span>
      <span className="tv-line__body">
        {line.speaker && <span className="tv-line__speaker">{line.speaker}: </span>}
        {highlightParts(line.text, query).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
      </span>
    </li>
  );
}
