import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  SETTINGS,
  deleteCandidateData,
  eraseAllData,
  exportCandidateData,
  exportRecording,
  purgeExpired,
  useRecordingsFor,
  useSessions,
  useSetting,
} from '../../db';
import { MAX_CANDIDATE, candidateKey, formatCandidateKey, isValidCandidate, isoDate } from '../../domain/plan';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DocLink,
  EmptyState,
  Field,
  HelpLink,
  SessionStateBadge,
  TextInput,
  downloadBlob,
  downloadFile,
  formatDate,
  formatDateTime,
  useToast,
} from '../../ui';
import { retentionStatus } from './model';
import { interviewersLabel } from '../../domain/interviewers';

/** PRIV-5, PRIV-6: retention, access and deletion requests, and erasing the device. */
export function Privacy() {
  return (
    <div className="stack-lg">
      <Retention />
      <CandidateRequests />
      <EraseAll />
    </div>
  );
}

function Retention() {
  const sessions = useSessions();
  const lastPurge = useSetting<string>(SETTINGS.lastPurgeAt);
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const today = isoDate(new Date());
  const rows = useMemo(
    () =>
      (sessions ?? [])
        .map((s) => ({ s, status: retentionStatus(s.candidate.retentionUntil, today) }))
        .sort((a, b) => a.s.candidate.retentionUntil.localeCompare(b.s.candidate.retentionUntil)),
    [sessions, today],
  );
  const expired = rows.filter((r) => r.status.expired).length;

  const purge = async () => {
    try {
      const n = await purgeExpired();
      toast(n ? `Purged ${n} expired interview${n === 1 ? '' : 's'}. Recorded in the audit log.` : 'Nothing to purge.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The purge failed.', 'error');
    } finally {
      setConfirm(false);
    }
  };

  return (
    <Card level={3} title="Retention" actions={<DocLink req="PRIV-5" />}>
      <div className="stack">
        <p>
          Every interview has a retention date (default 90 days after creation; HR sets the real period). Interviews past their
          retention date are purged each time the app opens, and each purge is recorded in the audit log without candidate
          details. <HelpLink slug="06-data-privacy" section="retention-and-deletion">Retention and deletion</HelpLink>
        </p>
        <p className="small muted">Last purge at app start: {formatDateTime(lastPurge ?? null)}</p>
        <div className="cluster">
          <Button onClick={() => setConfirm(true)} disabled={!expired}>
            Purge expired now{expired ? ` (${expired})` : ''}
          </Button>
          {!expired && <span className="small muted">No interview is past its retention date.</span>}
        </div>
        {sessions === undefined ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No interviews on this device." />
        ) : (
          <div className="table-wrap">
            <table className="table table--compact">
              <caption>Interviews by retention date</caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Interviewer</th>
                  <th scope="col">State</th>
                  <th scope="col">Created</th>
                  <th scope="col">Keep until</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, status }) => (
                  <tr key={s.id}>
                    <th scope="row">
                      {formatCandidateKey(s.candidate)}
                      {s.origin === 'imported' && <span className="muted small"> (imported)</span>}
                    </th>
                    <td>{interviewersLabel(s)}</td>
                    <td>
                      <SessionStateBadge state={s.state} />
                    </td>
                    <td className="nowrap">{formatDate(s.createdAt)}</td>
                    <td className="nowrap">{formatDate(s.candidate.retentionUntil)}</td>
                    <td className="nowrap">
                      {status.expired ? (
                        <Badge tone="danger" icon="alert">
                          {status.label}
                        </Badge>
                      ) : status.daysLeft <= 7 ? (
                        <Badge tone="warning" icon="clock">
                          {status.label}
                        </Badge>
                      ) : (
                        <span>{status.label}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirm} title="Purge expired interviews?" confirmLabel={`Purge ${expired}`} danger onConfirm={purge} onCancel={() => setConfirm(false)}>
        <p>
          {expired} interview{expired === 1 ? '' : 's'} past the retention date will be permanently deleted from this device,
          with their answers, notes, transcripts, recordings and AI second opinions. The audit log records the purge without candidate details.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function CandidateRequests() {
  const sessions = useSessions();
  const { toast } = useToast();
  const [initials, setInitials] = useState('');
  const [req, setReq] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'access' | 'delete' | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  /** TR-3: recordings held for the last access request, offered as separate downloads. */
  const [recordingIds, setRecordingIds] = useState<string[]>([]);
  const valid = isValidCandidate(initials);
  const key = valid ? candidateKey({ initials, requisitionId: req.trim() || null }) : null;
  const matches = key && sessions ? sessions.filter((s) => candidateKey(s.candidate) === key) : [];
  const shownKey = valid ? formatCandidateKey({ initials: initials.trim(), requisitionId: req.trim() || null }) : '';

  const open = (kind: 'access' | 'delete') => {
    if (!valid) {
      setError('Enter the candidate’s name or initials, as entered for the interview.');
      return;
    }
    setError(null);
    setDialog(kind);
  };

  const doAccess = async () => {
    try {
      const f = await exportCandidateData(initials.trim(), req.trim() || null);
      downloadFile(f.fileName, f.mime, f.text);
      setRecordingIds(f.recordingSessionIds);
      setLastResult(
        `Access request: exported ${f.sessionCount} interview${f.sessionCount === 1 ? '' : 's'} for ${shownKey}. Recorded in the audit log. The file includes any transcripts.` +
          (f.recordingSessionIds.length ? ` ${f.recordingSessionIds.length} recording${f.recordingSessionIds.length === 1 ? ' is' : 's are'} held: download below.` : ' No recording is held.'),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The export failed.', 'error');
    } finally {
      setDialog(null);
    }
  };
  const doDelete = async () => {
    try {
      const n = await deleteCandidateData(initials.trim(), req.trim() || null);
      setRecordingIds([]);
      setLastResult(`Deletion request: deleted ${n} interview${n === 1 ? '' : 's'} for ${shownKey}. Their transcripts, recordings and AI second opinions were deleted with them. Recorded in the audit log.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The deletion failed.', 'error');
    } finally {
      setDialog(null);
    }
  };

  return (
    <Card level={3} title="Access and deletion requests" actions={<DocLink req="PRIV-6" />}>
      <form className="stack" onSubmit={(e) => e.preventDefault()}>
        <p>
          A candidate can ask to see or delete their interview record. Find their data by the candidate’s name or initials plus
          the requisition id, as entered when the interview was set up (capitals and extra spaces do not matter).
        </p>
        <div className="adm-key">
          <Field label="Candidate" hint="Name or initials" error={error} required>
            <TextInput value={initials} onChange={(e) => setInitials(e.target.value)} maxLength={MAX_CANDIDATE} autoComplete="off" className="adm-initials" />
          </Field>
          <Field label="Requisition id" hint="Leave empty if none was recorded.">
            <TextInput value={req} onChange={(e) => setReq(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <p className="small" aria-live="polite">
          {valid ? `${matches.length} interview${matches.length === 1 ? '' : 's'} on this device for ${shownKey}.` : ''}
        </p>
        <div className="cluster">
          <Button icon="download" onClick={() => open('access')}>
            Export everything (access request)
          </Button>
          <Button variant="danger" icon="trash" onClick={() => open('delete')}>
            Delete everything (deletion request)
          </Button>
        </div>
        {lastResult && (
          <Alert tone="success" role="status">
            <p>{lastResult}</p>
          </Alert>
        )}
        {recordingIds.length > 0 && <RecordingDownloads sessionIds={recordingIds} />}
      </form>
      <ConfirmDialog open={dialog === 'access'} title="Export everything for this candidate?" confirmLabel="Export" onConfirm={doAccess} onCancel={() => setDialog(null)}>
        <p>
          This downloads a JSON file with all {matches.length} interview{matches.length === 1 ? '' : 's'} for <strong>{shownKey}</strong>,
          their plans, answers, notes, transcripts, AI second opinions and related audit entries, and says whether a recording is held
          (recordings are offered as separate downloads). Handle the files as personal data. The request is recorded in the audit log.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete everything for this candidate?"
        confirmLabel={`Delete ${matches.length} interview${matches.length === 1 ? '' : 's'}`}
        danger
        onConfirm={doDelete}
        onCancel={() => setDialog(null)}
      >
        <p>
          All {matches.length} interview{matches.length === 1 ? '' : 's'} for <strong>{shownKey}</strong> on this device, including
          imported panelist sessions, answers, notes, transcripts, recordings, AI second opinions and candidate details typed on draft plans,
          will be permanently deleted. Plans are
          kept (they hold no candidate data). Audit entries are kept, but note, rationale and reason text in their amendment entries is
          redacted. This cannot be undone.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

/** TR-3, PRIV-6: the recordings found by an access request, each downloaded on its own (audited as an export). */
function RecordingDownloads({ sessionIds }: { sessionIds: string[] }) {
  const recordings = useRecordingsFor(sessionIds);
  const { toast } = useToast();
  if (!recordings?.length) return null;
  const download = async (sessionId: string) => {
    try {
      const r = await exportRecording(sessionId);
      downloadBlob(r.fileName, r.blob);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };
  return (
    <div className="stack-sm">
      <p className="small">
        Recordings held for this candidate (not in the JSON file). <DocLink req="TR-3" />
      </p>
      <ul className="adm-recordings">
        {recordings.map((r, i) => (
          <li key={r.sessionId}>
            <Button size="sm" icon="download" onClick={() => void download(r.sessionId)}>
              Download recording {i + 1}
            </Button>{' '}
            <span className="small muted">
              {r.type}, {(r.size / (1024 * 1024)).toFixed(1)} MB, attached {formatDateTime(r.attachedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EraseAll() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  const close = () => {
    setOpen(false);
    setTyped('');
  };
  const erase = async () => {
    if (typed !== 'ERASE') return;
    setBusy(true);
    try {
      await eraseAllData('ERASE');
      setDone(true);
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erasing failed.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card level={3} title="Erase all data on this device" actions={<DocLink req="PRIV-6" />}>
      <p>
        Deletes every plan, interview, answer, note, transcript, recording, AI second opinion, setting and audit entry on this device,
        then reloads the bundled question bank. A single audit entry records that the erase happened.
      </p>
      <Button variant="danger" icon="trash" onClick={() => setOpen(true)}>
        Erase all data…
      </Button>
      {done && (
        <Alert tone="success" role="status">
          <p>
            All data on this device was erased. <Link to="/">Go to the dashboard</Link>
          </p>
        </Alert>
      )}
      <Dialog
        open={open}
        onClose={close}
        role="alertdialog"
        title="Erase all data on this device?"
        footer={
          <>
            <Button onClick={close} data-autofocus>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form="erase-form" disabled={typed !== 'ERASE' || busy}>
              Erase everything
            </Button>
          </>
        }
      >
        <form
          id="erase-form"
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void erase();
          }}
        >
          <Alert tone="danger" title="This cannot be undone.">
            <p>Export anything you need to keep first (session files, scorecards, the audit log).</p>
          </Alert>
          <Field label="Type ERASE to confirm">
            <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </form>
      </Dialog>
    </Card>
  );
}
