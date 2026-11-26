// Track files on the Question bank and Admin screens (BANK-4, BANK-6, BANK-7, BANK-14).
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { RepoError, checkTrackFile, exportTrackFile, importTrackFile, replaceWithBundledSeed, useTrackBank, type PendingSeedUpdate, type TrackFileCheck } from '../../db';
import { suggestNextVersion, trackVersionProblem } from '../../domain/bankEdit';
import { Alert, Badge, Button, ConfirmDialog, Dialog, DocLink, Field, TextInput, downloadFile, formatDateTime, readJsonFile, useToast } from '../../ui';

/** BANK-14: "this track has changes that have not been exported". Text and icon, not colour alone. */
export function UnexportedBadge({ changedAt }: { changedAt: string | null | undefined }) {
  if (!changedAt) return null;
  return (
    <Badge tone="warning" icon="edit">
      Unexported changes since {formatDateTime(changedAt)}
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
 * BANK-4, BANK-7: export a track file. Asks for the new track version (suggests the next one when
 * there are unexported changes) and clears the unexported-changes marker.
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
      toast(`Exported ${f.fileName} (version ${f.version}). To share it, replace seed/${f.fileName} with it and open a pull request.`, 'success');
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
        Downloads <span className="mono">{trackId}.json</span> for <strong>{bank.track.name}</strong>: every question, including retired ones, in the seed format.
        To share your changes, replace <span className="mono">seed/{trackId}.json</span> with it and review the diff in a pull request. <DocLink req="BANK-4" />
      </p>
      {bank.changedAt ? (
        <p>
          <UnexportedBadge changedAt={bank.changedAt} />
        </p>
      ) : (
        <p className="small muted">No changes since this track was loaded or last exported.</p>
      )}
      <Field
        label="Track version"
        required
        error={problem && value.trim() !== current ? problem : null}
        hint={`Currently ${current}. Devices load a seed only when its version is newer than theirs, so raise it when the questions changed.`}
      >
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

/**
 * BANK-7, SEC-2: import a track file. It is validated before anything changes. A track with
 * unexported changes on this device is only replaced after confirmation (BANK-6, BANK-14).
 */
export function ImportTrackFile({ onExportFirst, onImported }: { onExportFirst?: (trackId: string) => void; onImported?: (trackId: string) => void }) {
  const id = useId();
  const hintId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; details: string[] } | null>(null);
  const [pending, setPending] = useState<{ json: unknown; check: TrackFileCheck } | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async (json: unknown) => {
    setBusy(true);
    try {
      const r = await importTrackFile(json);
      setResult({ ok: true, message: `Imported track ${r.trackId}, version ${r.version}. Recorded in the audit log.`, details: [] });
      onImported?.(r.trackId);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'The file could not be imported.', details: err instanceof RepoError ? err.details : [] });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResult(null);
    setPending(null);
    try {
      const json = await readJsonFile(file);
      const check = await checkTrackFile(json);
      if (check.existing?.changedAt) {
        setPending({ json, check });
        setBusy(false);
      } else await doImport(json);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'The file could not be imported.', details: err instanceof RepoError ? err.details : [] });
      setBusy(false);
    } finally {
      if (ref.current) ref.current.value = '';
    }
  };

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={id} className="field__label">
          Track file (JSON)
        </label>
        <div id={hintId} className="field__hint">
          A file in the seed format. It is validated against the track schema before it is accepted, and replaces that track’s questions on this device
          whatever its version. <DocLink req="BANK-7" /> <DocLink req="BANK-3" />
        </div>
        <input ref={ref} id={id} type="file" accept=".json,application/json" className="file-input" aria-describedby={hintId} onChange={onChange} disabled={busy} />
      </div>
      <div aria-live="polite">
        {busy && <p className="muted">Checking the file…</p>}
        {pending && (
          <Alert tone="warning" title={`${pending.check.existing!.name} has changes on this device that have not been exported.`} role="alert">
            <p>
              Importing <span className="mono">{pending.check.trackId}</span> version {pending.check.version} ({pending.check.questions} questions) replaces them. Export them
              first if you want to keep them. <DocLink req="BANK-6" />
            </p>
            <div className="cluster">
              {onExportFirst && (
                <Button size="sm" icon="download" onClick={() => onExportFirst(pending.check.trackId)}>
                  Export my changes first…
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => doImport(pending.json)}>
                Replace with the file
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </Alert>
        )}
        {result && !busy && (
          <Alert tone={result.ok ? 'success' : 'danger'} title={result.ok ? result.message : `Not imported: ${result.message}`}>
            {result.details.length > 0 && (
              <ul className="adm-errors">
                {result.details.slice(0, 20).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
                {result.details.length > 20 && <li>…and {result.details.length - 20} more problems.</li>}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </div>
  );
}

/**
 * BANK-6: a newer bundled seed was not loaded because the track was changed on this device. Offers
 * to export the changes first, then to replace the track with the bundled version.
 */
export function PendingSeedAlert({ update, onExport }: { update: PendingSeedUpdate; onExport: (trackId: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const { toast } = useToast();
  return (
    <Alert tone="warning" title={`A newer version of ${update.name} (${update.bundledVersion}) is bundled with the app.`}>
      <p>
        This device has version {update.storedVersion}
        {update.changedAt ? ` with changes that have not been exported (since ${formatDateTime(update.changedAt)})` : ''}, so the newer version was not loaded
        automatically. Export your changes first if you want to keep them, then replace. Existing interviews are not affected. <DocLink req="BANK-6" />
      </p>
      <div className="cluster">
        <Button size="sm" icon="download" onClick={() => onExport(update.trackId)}>
          Export my changes…
        </Button>
        <Button size="sm" onClick={() => setConfirm(true)}>
          Replace with version {update.bundledVersion}…
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        danger
        title={`Replace ${update.name} with version ${update.bundledVersion}?`}
        confirmLabel="Replace"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            await replaceWithBundledSeed(update.trackId);
            toast(`${update.name} is now version ${update.bundledVersion}. Recorded in the audit log.`, 'success');
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not replace the track.', 'error');
          }
          setConfirm(false);
        }}
      >
        <p>The changes made on this device to this track are replaced by the bundled version. Interviews already set up keep their own copy of each question.</p>
      </ConfirmDialog>
    </Alert>
  );
}
