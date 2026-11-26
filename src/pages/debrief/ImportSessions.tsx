import { useId, useRef, useState, type ChangeEvent } from 'react';
import { RepoError, importSessionFile } from '../../db';
import { formatCandidateKey } from '../../domain/plan';
import { Alert, Button, DocLink, Icon, readJsonFile } from '../../ui';
import { MATCH_EXPLANATIONS, identityOfSessionFile, panelMatch, type PanelIdentity } from './model';
import { interviewersLabel } from '../../domain/interviewers';
import type { Session } from '../../domain/types';

interface ImportResult {
  fileName: string;
  ok: boolean;
  message: string;
  details: string[];
  /** For accepted files that are not part of this panel (FLOW-29). */
  mismatch?: string;
  panelist?: string;
}

/** FLOW-26, FLOW-27, SEC-2: import one or more panelist session files and report each result. */
export function ImportSessions({ panel }: { panel: PanelIdentity }) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [busy, setBusy] = useState(false);

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setBusy(true);
    const out: ImportResult[] = [];
    for (const file of files) {
      try {
        const json = await readJsonFile(file);
        await importSessionFile(json);
        const id = identityOfSessionFile(json);
        const match = id ? panelMatch(id, panel) : 'match';
        const panelist = interviewersLabel((json as { session: Pick<Session, 'interviewer' | 'interviewers'> }).session);
        out.push({
          fileName: file.name,
          ok: true,
          panelist,
          message: match === 'match' ? `Imported ${panelist}’s interview into this panel.` : `Imported ${panelist}’s interview.`,
          details: [],
          mismatch: match === 'match' ? undefined : MATCH_EXPLANATIONS[match],
        });
      } catch (err) {
        out.push({
          fileName: file.name,
          ok: false,
          message: err instanceof Error ? err.message : 'The file could not be imported.',
          details: err instanceof RepoError ? err.details : [],
        });
      }
    }
    setResults(out);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="stack dbf-import">
      <div className="field">
        <label htmlFor={inputId} className="field__label">
          Import other interviewers’ files
        </label>
        <div id={hintId} className="field__hint">
          The interview files they exported from their scorecard (Export › Interview file for the debrief). You can choose several at
          once; each is checked before use. <DocLink req="FLOW-26" />
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".json,application/json"
          multiple
          className="file-input"
          aria-describedby={hintId}
          onChange={onChange}
          disabled={busy}
        />
      </div>
      <div aria-live="polite" className="stack-sm">
        {busy && <p className="muted">Importing…</p>}
        {results.length > 0 && !busy && (
          <ul className="dbf-results">
            {results.map((r, i) => (
              <li key={i}>
                {r.ok && !r.mismatch ? (
                  <Alert tone="success" title={r.message}>
                    <p className="small mono">{r.fileName}</p>
                  </Alert>
                ) : r.ok ? (
                  <Alert tone="warning" title={`${r.message} It is not part of this panel.`}>
                    <p>{r.mismatch}</p>
                    <p className="small">
                      This panel is for candidate {formatCandidateKeyFromKey(panel.candidateKey)}, asked the questions with comparison code{' '}
                      <span className="mono">{(panel.fingerprint ?? '').slice(0, 8)}</span>. <DocLink req="FLOW-29" />
                    </p>
                    <p className="small mono">{r.fileName}</p>
                  </Alert>
                ) : (
                  <Alert tone="danger" title={`Not imported: ${r.message}`}>
                    <p className="small mono">{r.fileName}</p>
                    {r.details.length > 0 && (
                      <ul className="dbf-errors">
                        {r.details.slice(0, 12).map((d, j) => (
                          <li key={j}>{d}</li>
                        ))}
                        {r.details.length > 12 && <li>…and {r.details.length - 12} more problems.</li>}
                      </ul>
                    )}
                  </Alert>
                )}
              </li>
            ))}
          </ul>
        )}
        {results.length > 0 && !busy && (
          <p>
            <Button size="sm" variant="ghost" icon="x" onClick={() => setResults([])}>
              Clear import messages
            </Button>
          </p>
        )}
      </div>
      <p className="small muted">
        <Icon name="info" /> Importing the same interviewer’s file again replaces the earlier copy.
      </p>
    </div>
  );
}

function formatCandidateKeyFromKey(key: string): string {
  const [initials, req] = key.split('|');
  return formatCandidateKey({ initials: initials ?? '', requisitionId: req || null });
}
