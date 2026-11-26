import { useId, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import {
  RepoError,
  attachTranscript,
  confirmRecordingNotice,
  recordingNoticeGiven,
  removeTranscript,
  useAiSecondOpinion,
  useRecording,
  useTranscript,
  type TranscriptRecord,
} from '../../db';
import { RECORDING_CONSENT_TEXT } from '../../domain/plan';
import { TRANSCRIPT_FILE_ACCEPT, TranscriptError, parseTranscriptFile, parseTranscriptText, type Transcript } from '../../domain/transcript';
import type { InterviewPlan, Session } from '../../domain/types';
import { Alert, Button, Checkbox, ConfirmDialog, DocLink, Field, Icon, TextArea, buttonClass, formatDateTime, useToast } from '../../ui';
import { AiRunDialog } from './AiRunDialog';
import { FilePick } from './FilePick';
import { RecordingPanel } from './RecordingPanel';
import { TranscriptViewer, type FocusLineRequest } from './TranscriptViewer';
import { aiReadiness } from './model';
import { useAiAvailability } from './useAi';
import '../../styles/pages/transcript.css';

const FORMAT_LABEL: Record<Transcript['format'], string> = { text: 'Plain text', vtt: 'WebVTT (.vtt)', srt: 'SubRip (.srt)', docx: 'Word (.docx)' };

/**
 * TR-1…TR-4 and the AI run controls (AI-1…AI-3, AI-9): everything attached to one interview.
 * Used in the live interview (in a dialog, out of the way) and on the scorecard (its own section).
 */
export function TranscriptPanel({
  session,
  plan,
  focusLine,
  headingLevel = 3,
}: {
  session: Session;
  plan: InterviewPlan;
  focusLine?: FocusLineRequest | null;
  headingLevel?: 2 | 3;
}) {
  const transcript = useTranscript(session.id);
  const recording = useRecording(session.id);
  const media = useRef<HTMLMediaElement>(null);
  const local = session.origin === 'local';
  const started = session.state !== 'planned';
  const told = recordingNoticeGiven(session);

  if (!local) {
    return <p className="muted">Transcripts, recordings and AI second opinions are kept only with the interview they belong to; imported panelist sessions never carry them.</p>;
  }
  if (!started) {
    return <p className="muted">A transcript or recording can be attached once the interview has started.</p>;
  }

  const seek = recording
    ? (sec: number) => {
        const m = media.current;
        if (!m) return;
        m.currentTime = sec;
        m.focus();
        void m.play().catch(() => {});
      }
    : undefined;

  return (
    <div className="tp stack-lg">
      {!told && <LateNotice sessionId={session.id} />}
      <TranscriptBlock session={session} transcript={transcript} canAttach={told} onSeek={seek} focusLine={focusLine} headingLevel={headingLevel} />
      <RecordingPanel ref={media} sessionId={session.id} recording={recording ?? null} canAttach={told} />
      <AiControls session={session} plan={plan} transcript={transcript ?? null} />
      <p className="small muted tp-foot">
        <Icon name="info" /> They stay on this device with this interview, are never in the file shared for the debrief, and are deleted with
        the interview. <DocLink req="TR-3" />
      </p>
    </div>
  );
}

/** TR-4: the option was off at setup: confirm the candidate has since been told before attaching. */
function LateNotice({ sessionId }: { sessionId: string }) {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = async () => {
    if (!checked) {
      setError('Tick the box to confirm the candidate has been told.');
      return;
    }
    try {
      await confirmRecordingNotice(sessionId);
      toast('Recorded: the candidate has been told. The time is stored and audited.', 'success');
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'Could not save.');
    }
  };
  return (
    <div className="consent tp-notice">
      <p className="consent__title">
        The candidate was not told this interview is recorded or transcribed <DocLink req="TR-4" />
      </p>
      <p className="small">This was not ticked when the interview was set up. Before attaching a transcript or recording, tell the candidate:</p>
      <blockquote className="consent__text">
        <p>{RECORDING_CONSENT_TEXT}</p>
      </blockquote>
      <Checkbox
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          setError(null);
        }}
        label="I confirm the candidate has since been told the text above."
        description="The time you confirm is stored with the candidate’s consent and recorded in the audit log."
      />
      {error && (
        <p className="field__error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
      <div>
        <Button icon="check" onClick={() => void confirm()}>
          Confirm and continue
        </Button>
      </div>
    </div>
  );
}

function TranscriptBlock({
  session,
  transcript,
  canAttach,
  onSeek,
  focusLine,
  headingLevel,
}: {
  session: Session;
  transcript: TranscriptRecord | null | undefined;
  canAttach: boolean;
  onSeek?: (sec: number) => void;
  focusLine?: FocusLineRequest | null;
  headingLevel: 2 | 3;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { toast } = useToast();
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState<Transcript | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const H = headingLevel === 2 ? 'h3' : 'h4';

  const attach = async (t: Transcript) => {
    try {
      const r = await attachTranscript(session.id, t);
      toast(r.replaced ? 'Transcript replaced.' : 'Transcript attached.', 'success');
      setReplacing(false);
    } catch (e) {
      toast(e instanceof RepoError ? e.message : 'The transcript could not be attached.', 'error');
    } finally {
      setPending(null);
    }
  };
  const parsed = (t: Transcript) => {
    if (transcript) setPending(t);
    else void attach(t);
  };

  return (
    <section className="tp-block" aria-labelledby={`${id}-h`}>
      <div className="tp-block__head">
        <H id={`${id}-h`} className="tp-block__title">
          <Icon name="doc" /> Transcript
        </H>
        <DocLink req="TR-1" />
      </div>
      {transcript === undefined ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : transcript && !replacing ? (
        <div className="stack">
          <div className="tp-meta">
            <p className="small">
              {FORMAT_LABEL[transcript.format]} · {transcript.transcript.segments.length.toLocaleString('en')} lines ·{' '}
              {transcript.transcript.speakers.length ? `speakers ${transcript.transcript.speakers.join(', ')}` : 'no speaker names'} · attached{' '}
              {formatDateTime(transcript.attachedAt)}
            </p>
            <div className="cluster">
              <Button size="sm" icon="upload" onClick={() => setReplacing(true)}>
                Replace…
              </Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmRemove(true)}>
                Remove transcript…
              </Button>
            </div>
          </div>
          <TranscriptViewer transcript={transcript.transcript} onSeek={onSeek} focusLine={focusLine} />
        </div>
      ) : (
        <AttachTranscript disabled={!canAttach} onParsed={parsed} onCancel={transcript ? () => setReplacing(false) : undefined} />
      )}
      <ConfirmDialog
        open={!!pending}
        title="Replace the transcript?"
        confirmLabel="Replace transcript"
        onConfirm={() => (pending ? attach(pending) : undefined)}
        onCancel={() => setPending(null)}
      >
        <p>
          The attached transcript is replaced by the new one ({pending?.segments.length.toLocaleString('en')} lines). An AI second opinion based on the old
          transcript is kept but marked out of date. The change is recorded in the audit log, without the text.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the transcript?"
        confirmLabel="Remove transcript"
        danger
        onConfirm={async () => {
          try {
            await removeTranscript(session.id);
            toast('Transcript removed.', 'success');
          } catch (e) {
            toast(e instanceof RepoError ? e.message : 'The transcript could not be removed.', 'error');
          } finally {
            setConfirmRemove(false);
          }
        }}
        onCancel={() => setConfirmRemove(false)}
      >
        <p>The transcript is deleted from this device. An AI second opinion based on it is kept but marked out of date. The removal is recorded in the audit log.</p>
      </ConfirmDialog>
    </section>
  );
}

/** TR-1: choose or drop a .txt/.vtt/.srt/.docx file, or paste text. Parse errors are shown in plain words. */
function AttachTranscript({ disabled, onParsed, onCancel }: { disabled: boolean; onParsed: (t: Transcript) => void; onCancel?: () => void }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const handle = async (fn: () => Promise<Transcript> | Transcript) => {
    setBusy(true);
    setError(null);
    try {
      onParsed(await fn());
      setText('');
    } catch (e) {
      setError(e instanceof TranscriptError ? e.message : 'The transcript could not be read.');
    } finally {
      setBusy(false);
    }
  };
  const fromFile = (f: File) => void handle(() => parseTranscriptFile(f));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !disabled) fromFile(f);
  };

  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label="How to add the transcript">
        <Button size="sm" aria-pressed={mode === 'file'} onClick={() => setMode('file')}>
          Choose a file
        </Button>
        <Button size="sm" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>
          Paste text
        </Button>
      </div>
      {mode === 'file' ? (
        <div
          className={`tp-drop${dragging ? ' tp-drop--over' : ''}${disabled ? ' tp-drop--disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="small">Drop a transcript file here, or</p>
          <FilePick label="Choose a transcript file…" inputLabel="Transcript file" accept={TRANSCRIPT_FILE_ACCEPT} disabled={disabled || busy} onFile={fromFile} />
          <p className="small muted">.txt, .vtt, .srt or .docx, as exported by Teams or Zoom. Up to 500,000 characters.</p>
        </div>
      ) : (
        <div className="stack-sm">
          <Field label="Transcript text" hint="Paste the transcript, for example copied from Teams. Speaker names and timestamps are kept where present.">
            <TextArea id={`${id}-paste`} rows={8} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || busy} spellCheck={false} />
          </Field>
          <div>
            <Button size="sm" variant="primary" icon="check" disabled={disabled || busy || !text.trim()} onClick={() => void handle(() => parseTranscriptText(text))}>
              Attach pasted text
            </Button>
          </div>
        </div>
      )}
      {busy && (
        <p className="small" role="status">
          Reading the transcript…
        </p>
      )}
      {error && (
        <Alert tone="danger" role="alert" title="The transcript was not attached.">
          <p>{error}</p>
        </Alert>
      )}
      {onCancel && (
        <div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Keep the current transcript
          </Button>
        </div>
      )}
    </div>
  );
}

/** AI-1, AI-2, AI-3, AI-9: run controls and the state of the AI second opinion. */
function AiControls({ session, plan, transcript }: { session: Session; plan: InterviewPlan; transcript: TranscriptRecord | null }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const view = useAiSecondOpinion(session.id);
  const submitted = session.state === 'submitted';

  return (
    <section className="tp-block tp-ai" aria-labelledby={`${id}-h`}>
      <div className="tp-block__head">
        <h4 id={`${id}-h`} className="tp-block__title">
          <Icon name="steer" /> AI second opinion
        </h4>
        <DocLink req="AI-3" />
      </div>
      {view?.state === 'pending' && (
        <p className="tp-ai__ready" role="status">
          <Icon name="check" /> <strong>AI second opinion is ready — shown after you submit.</strong>{' '}
          <span className="small muted">
            Run {formatDateTime(view.createdAt)} with {view.model}. <DocLink req="AI-9" />
          </span>
        </p>
      )}
      {view?.state === 'ready' && (
        <p className="small">
          {view.outOfDate ? (
            <>
              <Icon name="alert" /> <strong>Out of date:</strong> the transcript changed after the last run ({formatDateTime(view.record.result.createdAt)}). Run it
              again to update it.
            </>
          ) : (
            <>
              <Icon name="check" /> Run {formatDateTime(view.record.result.createdAt)} with {view.record.result.model}.
            </>
          )}{' '}
          {submitted && (
            <Link to={`/scorecard/${session.id}?section=ai`} className="no-print">
              See it on the scorecard
            </Link>
          )}
        </p>
      )}
      <AiRunButton session={session} plan={plan} transcript={transcript} />
    </section>
  );
}

/**
 * AI-1, AI-2, AI-3: "Run AI second opinion…" when the feature is on, the helper is ready and a
 * transcript is attached; otherwise why it cannot run (and where to fix it).
 */
export function AiRunButton({ session, plan, transcript }: { session: Session; plan: InterviewPlan; transcript: TranscriptRecord | null | undefined }) {
  const { settings, status, recheck } = useAiAvailability();
  const view = useAiSecondOpinion(session.id);
  const [open, setOpen] = useState(false);
  const readiness = aiReadiness({ settings, status, hasTranscript: !!transcript, origin: session.origin, started: session.state !== 'planned' });
  const previous = view?.state === 'ready' ? view.record.speakerMapping : null;
  const again = view?.state === 'ready' || view?.state === 'pending';
  return (
    <>
      {readiness.canRun ? (
        <div className="cluster">
          <Button icon="play" variant={again ? 'default' : 'primary'} onClick={() => setOpen(true)}>
            {again ? 'Run AI second opinion again…' : 'Run AI second opinion…'}
          </Button>
          <span className="small muted">
            Helper ready{status?.state === 'ready' && status.cliVersion ? ` (Claude Code ${status.cliVersion}${status.model ? `, model ${status.model}` : ''})` : ''}. Nothing is
            sent until you confirm.
          </span>
        </div>
      ) : (
        <div className="tp-ai__unavailable">
          <p className="small">
            <Icon name="info" /> {readiness.message}
          </p>
          {readiness.reason === 'off' && (
            <Link className={buttonClass('default', 'sm')} to="/admin?tab=ai">
              Open Admin › AI second opinion
            </Link>
          )}
          {(readiness.reason === 'unavailable' || readiness.reason === 'busy') && (
            <Button size="sm" variant="ghost" icon="undo" onClick={recheck}>
              Check again
            </Button>
          )}
        </div>
      )}
      {transcript && <AiRunDialog open={open} onClose={() => setOpen(false)} session={session} plan={plan} transcript={transcript} previousMapping={previous} />}
    </>
  );
}
