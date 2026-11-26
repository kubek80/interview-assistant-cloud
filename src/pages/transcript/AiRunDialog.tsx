import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AiClientError, AI_ERROR_MESSAGES, requestSecondOpinion } from '../../ai/client';
import { RepoError, recordAiRunFailed, saveAiResult, type TranscriptRecord } from '../../db';
import {
  AI_DESTINATION,
  AiRequestError,
  buildSecondOpinionRequest,
  createSecondOpinion,
  describePayload,
  pseudonymiseTranscript,
  suggestSpeakerMapping,
  type PayloadDisclosure,
  type PseudonymisedTranscript,
  type SecondOpinionRequest,
  type SpeakerMapping,
} from '../../domain/ai';
import type { InterviewPlan, Session } from '../../domain/types';
import { Alert, Button, Dialog, DocLink, Field, Icon, IconButton, Select, TextInput, formatDuration } from '../../ui';
import { checkMapping, formatBytes, speakerLabelOptions, type ExtraName } from './model';

type Step = 'map' | 'disclose' | 'running' | 'failed' | 'done';

interface Prepared {
  sent: PseudonymisedTranscript;
  request: SecondOpinionRequest;
  disclosure: PayloadDisclosure;
}

/**
 * AI-3, AI-5, AI-6: run the AI second opinion in three steps: (1) who is speaking (names become
 * labels), (2) exactly what is sent and where, (3) run with progress and cancel. A reply that does
 * not fit is shown as an error and nothing is stored. The result is stored with saveAiResult; it
 * never touches a human score (AI-10) and stays hidden until the interview is submitted (AI-9).
 */
export function AiRunDialog({
  open,
  onClose,
  session,
  plan,
  transcript,
  previousMapping,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  plan: InterviewPlan;
  transcript: TranscriptRecord;
  previousMapping?: SpeakerMapping | null;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Run AI second opinion" wide>
      {open && <AiRun key={transcript.hash} onClose={onClose} session={session} plan={plan} transcript={transcript} previousMapping={previousMapping} />}
    </Dialog>
  );
}

function initialMapping(t: TranscriptRecord, previous?: SpeakerMapping | null): SpeakerMapping {
  const suggested = suggestSpeakerMapping(t.transcript);
  if (!previous) return suggested;
  const out: SpeakerMapping = {};
  for (const sp of t.transcript.speakers) out[sp] = previous[sp] ?? suggested[sp];
  return out;
}

function AiRun({
  onClose,
  session,
  plan,
  transcript,
  previousMapping,
}: {
  onClose: () => void;
  session: Session;
  plan: InterviewPlan;
  transcript: TranscriptRecord;
  previousMapping?: SpeakerMapping | null;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const t = transcript.transcript;
  const [step, setStep] = useState<Step>('map');
  const [mapping, setMapping] = useState<SpeakerMapping>(() => initialMapping(transcript, previousMapping));
  const [extra, setExtra] = useState<ExtraName[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; message: string; details: string[] } | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const submitted = session.state === 'submitted';
  const options = useMemo(() => speakerLabelOptions(t.speakers.length).map((l) => ({ value: l, label: l })), [t.speakers.length]);
  const check = checkMapping(t, mapping, extra);
  const words = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of t.segments) if (s.speaker) m.set(s.speaker, (m.get(s.speaker) ?? 0) + s.text.split(/\s+/).filter(Boolean).length);
    return m;
  }, [t]);

  // Stop a run when the dialog closes.
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (step !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);
  // Each step starts at its heading.
  useEffect(() => {
    document.getElementById(`${id}-step`)?.focus();
  }, [step, id]);

  const toDisclosure = () => {
    setAttempted(true);
    if (!check.ok) return;
    setPrepError(null);
    try {
      const sent = pseudonymiseTranscript(t, mapping, extra.map((e) => ({ name: e.name.trim(), label: e.label })));
      const request = buildSecondOpinionRequest({ questions: plan.questions, transcript: sent });
      setPrepared({ sent, request, disclosure: describePayload(request) });
      setStep('disclose');
    } catch (e) {
      setPrepError(e instanceof AiRequestError || e instanceof Error ? e.message : 'The request could not be prepared.');
    }
  };

  const run = async () => {
    if (!prepared) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setFailure(null);
    setStartedAt(Date.now());
    setNow(Date.now());
    setStep('running');
    const questions = plan.questions.length;
    try {
      const response = await requestSecondOpinion(prepared.request, { signal: ctrl.signal });
      const created = createSecondOpinion({ plan, sentTranscript: prepared.sent, response });
      if (!created.ok) {
        // AI-6: a reply that does not fit is never shown as scores, and nothing is stored.
        await recordAiRunFailed(session.id, 'invalid_output', questions).catch(() => {});
        setFailure({ title: 'The AI reply was rejected. Nothing was stored.', message: AI_ERROR_MESSAGES.invalid_output, details: created.errors.slice(0, 8) });
        setStep('failed');
        return;
      }
      await saveAiResult(session.id, created.result, mapping, extra.length);
      setStep('done');
    } catch (e) {
      if (ctrl.signal.aborted && !(e instanceof RepoError)) {
        await recordAiRunFailed(session.id, 'aborted', questions).catch(() => {});
        setFailure({ title: 'Cancelled. Nothing was stored.', message: AI_ERROR_MESSAGES.aborted, details: [] });
      } else if (e instanceof AiClientError) {
        await recordAiRunFailed(session.id, e.code, questions).catch(() => {});
        setFailure({ title: 'The AI second opinion did not run. Nothing was stored.', message: e.message, details: [] });
      } else if (e instanceof RepoError) {
        setFailure({ title: 'The result was not kept.', message: e.message, details: [] });
      } else {
        setFailure({ title: 'The AI second opinion did not run. Nothing was stored.', message: 'Something went wrong. Try again.', details: [] });
      }
      setStep('failed');
    } finally {
      abort.current = null;
    }
  };

  const stepHeading = (n: number, text: string) => (
    <h3 id={`${id}-step`} tabIndex={-1} className="ai-step__title">
      <span className="ai-step__n">Step {n} of 3</span> {text}
    </h3>
  );

  if (step === 'map') {
    return (
      <div className="stack ai-step">
        <ol className="ai-steps" aria-label="Steps">
          <li aria-current="step">Who is speaking</li>
          <li>What is sent</li>
          <li>Run</li>
        </ol>
        {stepHeading(1, 'Who is speaking')}
        <p className="small">
          Speaker names are replaced with labels before anything is sent, and the same names are replaced wherever they are spoken. Mark which speaker is
          the candidate. <DocLink req="AI-5" />
        </p>
        {t.speakers.length === 0 ? (
          <Alert tone="warning" title="This transcript has no speaker names.">
            <p>The AI cannot tell the candidate’s words from the interviewers’. Use a transcript export with speaker names (Teams and Zoom include them) for a useful result.</p>
          </Alert>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Speakers">
            <table className="table table--compact ai-map">
              <caption>Speakers in the transcript</caption>
              <thead>
                <tr>
                  <th scope="col">Speaker in the transcript</th>
                  <th scope="col" className="num">
                    Words
                  </th>
                  <th scope="col">Sent as</th>
                </tr>
              </thead>
              <tbody>
                {t.speakers.map((sp, i) => {
                  const problem = attempted ? check.problems.find((p) => p.speaker === sp) : undefined;
                  return (
                    <tr key={sp}>
                      <th scope="row" className="ai-map__name">
                        {sp}
                      </th>
                      <td className="num">{(words.get(sp) ?? 0).toLocaleString('en')}</td>
                      <td>
                        <Field label={`Label for speaker ${i + 1}`} hideLabel error={problem?.message}>
                          <Select options={options} value={mapping[sp] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [sp]: e.target.value }))} />
                        </Field>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {attempted && check.problems.some((p) => p.code === 'no-candidate') && (
          <p className="field__error" role="alert">
            <Icon name="alert" /> <span>Mark which speaker is the candidate.</span>
          </p>
        )}
        <fieldset className="ai-extra">
          <legend>Other names to replace (optional)</legend>
          <p className="small muted">
            For example the candidate’s name when the transcript lists them as “Guest”, or a colleague who is mentioned. Replaced as whole words.
          </p>
          {extra.map((e, i) => (
            <div key={i} className="ai-extra__row">
              <Field label={`Name ${i + 1}`} error={attempted ? check.extraProblems[i] : null}>
                <TextInput value={e.name} onChange={(ev) => setExtra((x) => x.map((y, j) => (j === i ? { ...y, name: ev.target.value.slice(0, 100) } : y)))} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={`Replace name ${i + 1} with`}>
                <Select options={options} value={e.label} onChange={(ev) => setExtra((x) => x.map((y, j) => (j === i ? { ...y, label: ev.target.value } : y)))} />
              </Field>
              <IconButton icon="trash" label={`Remove name ${i + 1}`} onClick={() => setExtra((x) => x.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" icon="plus" onClick={() => setExtra((x) => [...x, { name: '', label: 'Candidate' }])} disabled={extra.length >= 10}>
              Add a name to replace
            </Button>
          </div>
        </fieldset>
        {prepError && (
          <Alert tone="danger" role="alert" title="The request could not be prepared.">
            <p>{prepError}</p>
          </Alert>
        )}
        <div className="pc-dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={toDisclosure}>
            Next: what is sent <Icon name="chevron-right" />
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'disclose' && prepared) {
    const d = prepared.disclosure;
    return (
      <div className="stack ai-step">
        <ol className="ai-steps" aria-label="Steps">
          <li>Who is speaking</li>
          <li aria-current="step">What is sent</li>
          <li>Run</li>
        </ol>
        {stepHeading(2, 'What is sent, and where')}
        <div className="ai-disclose">
          <section aria-labelledby={`${id}-sent`} className="ai-disclose__col">
            <h4 id={`${id}-sent`}>
              <Icon name="upload" /> Sent
            </h4>
            <ul className="ai-list">
              {d.sent.map((c) => (
                <li key={c.label}>
                  <strong>{c.label}:</strong> {c.detail}
                </li>
              ))}
              <li>
                <strong>Scoring instructions:</strong> the app’s fixed instructions, added by the helper on this computer.
              </li>
            </ul>
            <p className="small muted">
              {prepared.sent.replacedNameCount} name{prepared.sent.replacedNameCount === 1 ? '' : 's'} replaced inside what was said. Request size{' '}
              {formatBytes(d.totalBytes)}.
            </p>
          </section>
          <section aria-labelledby={`${id}-notsent`} className="ai-disclose__col">
            <h4 id={`${id}-notsent`}>
              <Icon name="lock" /> Not sent
            </h4>
            <ul className="ai-list">
              {d.notSent.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        </div>
        <p className="ai-destination">
          <strong>Where it goes:</strong> {AI_DESTINATION} <DocLink req="AI-3" />
        </p>
        <details className="ai-preview">
          <summary>Show exactly the transcript that will be sent ({d.transcriptLines.toLocaleString('en')} lines)</summary>
          <pre className="ai-preview__text" tabIndex={0} role="region" aria-label="Transcript as it will be sent">
            {prepared.sent.text}
          </pre>
        </details>
        <details className="ai-preview">
          <summary>Show the questions that will be sent ({d.questionCount})</summary>
          <ol className="ai-preview__questions">
            {prepared.request.questions.map((q) => (
              <li key={q.id}>{q.text}</li>
            ))}
          </ol>
        </details>
        {!submitted && (
          <Alert tone="info" title="The result stays hidden until the interview is submitted.">
            <p>
              So that it cannot influence your scores, the app only says that it is ready until you submit. <DocLink req="AI-9" />
            </p>
          </Alert>
        )}
        <div className="pc-dialog-actions">
          <Button icon="chevron-left" onClick={() => setStep('map')}>
            Back
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="play" onClick={() => void run()}>
            Send and run
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'running') {
    return (
      <div className="stack ai-step">
        {stepHeading(3, 'Running')}
        <div role="status" className="ai-running">
          <progress className="ai-progress" aria-label="AI second opinion in progress" />
          <p>
            The AI is reading the transcript and scoring {plan.questions.length} questions. This can take a few minutes.{' '}
            <span className="tabular muted">{formatDuration(Math.max(0, now - startedAt))} elapsed</span>
          </p>
        </div>
        <div className="pc-dialog-actions">
          <Button icon="x" onClick={() => abort.current?.abort()}>
            Cancel the run
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'failed' && failure) {
    return (
      <div className="stack ai-step">
        {stepHeading(3, 'Not completed')}
        <Alert tone="danger" role="alert" title={failure.title}>
          <p>{failure.message}</p>
          {failure.details.length > 0 && (
            <ul className="small">
              {failure.details.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
        </Alert>
        <div className="pc-dialog-actions">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon="undo" onClick={() => void run()} disabled={!prepared}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack ai-step">
      {stepHeading(3, 'Done')}
      <Alert tone="success" role="status" title={submitted ? 'The AI second opinion is ready.' : 'AI second opinion is ready — shown after you submit.'}>
        <p>
          {submitted
            ? 'It is shown on the scorecard in its own section, beside the interviewers’ scores. It changes no score or decision.'
            : 'It stays hidden until the interview is submitted, so it cannot influence the human scores.'}{' '}
          <DocLink req={submitted ? 'AI-11' : 'AI-9'} />
        </p>
      </Alert>
      <div className="pc-dialog-actions">
        <Button variant="primary" onClick={onClose} data-autofocus>
          Close
        </Button>
      </div>
    </div>
  );
}
