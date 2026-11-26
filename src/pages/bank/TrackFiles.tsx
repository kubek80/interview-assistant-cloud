// Track files on the Question bank and Admin screens (BANK-4, BANK-7, BANK-14, DB-3, DB-4).
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { RepoError, exportTrackFile, importQuestionFiles, useTrackBank, useTracks } from '../../db';
import { suggestNextVersion, trackVersionProblem } from '../../domain/bankEdit';
import type { ImportFileInput, ImportReport } from '../../shared/api';
import { Alert, Badge, Button, Dialog, DocLink, Field, Select, TextInput, downloadFile, formatDateTime, useToast } from '../../ui';

/** BANK-14: "this track has changes that have not been exported". Text and icon, not colour alone. */
export function UnexportedBadge({ changedAt }: { changedAt: string | null | undefined }) {
  if (!changedAt) return null;
  return (
    <Badge tone="warning" icon="edit">
      Not exported since {formatDateTime(changedAt)}
    </Badge>
  );
}

function Problems({ message, details }: { message: string; details: string[] }) {
  return (
    <Alert tone="danger" title={message} role="alert">
      {details.length > 0 && (
        <ul className="adm-errors">
          {details.slice(0, 20).map((d, i) => (
            <li key={i}>{d}</li>
          ))}
          {details.length > 20 && <li>…and {details.length - 20} more problems.</li>}
        </ul>
      )}
    </Alert>
  );
}

/**
 * DB-4, BANK-7: export a track file. Asks for the track version (suggests the next one when there
 * are changes not yet exported) and clears the "not exported" marker.
 */
export function ExportTrackDialog({ trackId, onClose }: { trackId: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!trackId} onClose={onClose} title="Export track file">
      {trackId && <ExportForm key={trackId} trackId={trackId} onDone={onClose} />}
    </Dialog>
  );
}

function ExportForm({ trackId, onDone }: { trackId: string; onDone: () => void }) {
  const bank = useTrackBank(trackId);
  const { toast } = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  if (!bank) return <p className="muted">Loading…</p>;
  const current = bank.track.version;
  const value = version ?? (bank.changedAt ? suggestNextVersion(current, new Date()) : current);
  const problem = trackVersionProblem(value.trim(), current);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem && value.trim() !== current) return;
    setBusy(true);
    setError(null);
    try {
      const f = await exportTrackFile(trackId, { version: value.trim() });
      downloadFile(f.fileName, f.mime, f.text);
      toast(`Exported ${f.fileName} (version ${f.version}).`, 'success');
      onDone();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'The export failed.', details: err instanceof RepoError ? err.details : [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form id={id} onSubmit={submit} className="stack">
      <p>
        Downloads <span className="mono">{trackId}.json</span> for <strong>{bank.track.name}</strong>: every question, including retired ones. Keep it as a copy, or
        import it into another installation. <DocLink req="DB-4" />
      </p>
      {bank.changedAt ? (
        <p>
          <UnexportedBadge changedAt={bank.changedAt} />
        </p>
      ) : (
        <p className="small muted">No changes since this track was imported or last exported.</p>
      )}
      <Field label="Track version" required error={problem && value.trim() !== current ? problem.replace(/, so devices load it \(BANK-6\)/, '') : null} hint={`Currently ${current}. Raise it when the questions changed.`}>
        <TextInput data-autofocus value={value} onChange={(e) => setVersion(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      {error && <Problems {...error} />}
      <div className="pc-dialog-actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" icon="download" disabled={busy}>
          Export {trackId}.json
        </Button>
      </div>
    </form>
  );
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * DB-3: upload track files (.json) or CSV files, see what importing them would add, change and
 * leave alone, then confirm. Nothing changes until "Import" is pressed, and nothing at all if any
 * file has a problem.
 */
export function ImportQuestions({ onImported }: { onImported?: (trackIds: string[]) => void }) {
  const inputId = useId();
  const hintId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const tracks = useTracks();
  const { toast } = useToast();
  const [files, setFiles] = useState<ImportFileInput[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const csvTrack = files.find((f) => /\.csv$/i.test(f.name))?.trackId ?? '';
  const hasCsv = files.some((f) => /\.csv$/i.test(f.name));

  const check = async (list: ImportFileInput[]) => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await importQuestionFiles(list, true));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The files could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(e.target.files ?? [])];
    if (!chosen.length) return;
    if (chosen.some((f) => f.size > MAX_FILE_BYTES)) {
      setError('A file is too large (5 MB at most).');
      return;
    }
    const list = await Promise.all(chosen.map(async (f) => ({ name: f.name, text: await f.text() })));
    setFiles(list);
    await check(list);
  };

  const setTrack = async (trackId: string) => {
    const list = files.map((f) => (/\.csv$/i.test(f.name) ? { ...f, trackId: trackId || undefined } : f));
    setFiles(list);
    await check(list);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await importQuestionFiles(files, false);
      setReport(null);
      setFiles([]);
      if (ref.current) ref.current.value = '';
      const added = r.tracks.reduce((n, t) => n + t.added.length, 0);
      const changed = r.tracks.reduce((n, t) => n + t.changed.length, 0);
      toast(`Imported: ${added} added, ${changed} changed. Recorded in the audit log.`, 'success');
      onImported?.(r.tracks.map((t) => t.trackId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  const changes = report?.ok ? report.tracks.reduce((n, t) => n + t.added.length + t.changed.length + t.categoriesAdded.length + t.categoriesChanged.length + (t.trackAction === 'create' ? 1 : 0) + t.trackChanges.length, 0) : 0;

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={inputId} className="field__label">
          Track files or CSV files
        </label>
        <div id={hintId} className="field__hint">
          Track files (.json) in the export format, or CSV files in the bulk-add layout. You see what would change before anything is imported. <DocLink req="DB-3" />
        </div>
        <input ref={ref} id={inputId} type="file" multiple accept=".json,.csv,application/json,text/csv" className="file-input" aria-describedby={hintId} onChange={onChange} disabled={busy} />
      </div>
      {hasCsv && tracks && (
        <Field label="Track for the CSV file" hint="CSV files do not say which track they belong to.">
          <Select value={csvTrack} onChange={(e) => void setTrack(e.target.value)} placeholder="Choose a track" options={tracks.map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
      )}
      <div aria-live="polite" className="stack">
        {busy && <p className="muted">Checking…</p>}
        {error && <Alert tone="danger" title={error} role="alert" />}
        {report && !busy && <ImportReportView report={report} />}
        {report?.ok && !busy && (
          <div className="cluster">
            <Button variant="primary" icon="upload" onClick={confirm} disabled={!changes}>
              {changes ? 'Import' : 'Nothing to import'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setReport(null);
                setFiles([]);
                if (ref.current) ref.current.value = '';
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** DB-2, DB-3: the import report, in the same words as the command line. */
export function ImportReportView({ report }: { report: ImportReport }) {
  if (!report.ok) {
    return (
      <Alert tone="danger" title="These files have problems. Nothing was imported." role="alert">
        {report.problems.map((p) => (
          <div key={p.source}>
            <p>
              <strong>{p.source}</strong>
            </p>
            <ul className="adm-errors">
              {p.messages.slice(0, 20).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
              {p.messages.length > 20 && <li>…and {p.messages.length - 20} more.</li>}
            </ul>
          </div>
        ))}
      </Alert>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table table--compact">
        <caption className="visually-hidden">What the import would do</caption>
        <thead>
          <tr>
            <th scope="col">Track</th>
            <th scope="col" className="num">
              Added
            </th>
            <th scope="col" className="num">
              Changed
            </th>
            <th scope="col" className="num">
              Unchanged
            </th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {report.tracks.map((t) => (
            <tr key={`${t.source}-${t.trackId}`}>
              <th scope="row">
                {t.name} <span className="small muted">({t.source})</span>
                {t.trackAction === 'create' && (
                  <>
                    {' '}
                    <Badge tone="info">New track</Badge>
                  </>
                )}
              </th>
              <td className="num">{t.added.length}</td>
              <td className="num">{t.changed.length}</td>
              <td className="num">{t.unchanged}</td>
              <td className="small">
                <ul className="adm-report">
                  {t.trackChanges.map((c) => (
                    <li key={c}>Track {c}</li>
                  ))}
                  {t.categoriesAdded.length > 0 && <li>New categories: {t.categoriesAdded.join(', ')}</li>}
                  {t.categoriesChanged.length > 0 && <li>Changed categories: {t.categoriesChanged.join(', ')}</li>}
                  {t.changed.slice(0, 10).map((c) => (
                    <li key={c.id}>
                      Question {c.number}: version {c.fromVersion} → {c.toVersion}
                    </li>
                  ))}
                  {t.changed.length > 10 && <li>…and {t.changed.length - 10} more changed.</li>}
                  {t.keptNewer.length > 0 && <li>{t.keptNewer.length} kept as they are: edited here since the file was made.</li>}
                  {t.notInFile > 0 && <li>{t.notInFile} not in the file: left as they are.</li>}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
