import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { RepoError, getInterviewerName, importAnyFile, kindOf, setInterviewerName, takeTheirs, type ImportedFileResult, type InvitationImportItem, type PanelImportItem } from '../../db';
import { RECOMMENDATION_LABELS, type PanelDecision, type WrittenSummary } from '../../domain/types';
import { Button, Dialog, Field, Icon, TextInput, readJsonFile } from '../../ui';
import { formatNames } from '../../domain/interviewers';
import { NO_MATCH_EXPLANATIONS, localDay, whenLabel } from '../../domain/team';

interface FileOutcome {
  fileName: string;
  ok: boolean;
  /** One plain sentence. */
  title: string;
  lines: string[];
  warning?: boolean;
  /** Where to look next. */
  link?: { to: string; label: string };
  /** TEAM-13: a panel decision or summary that differs from this device's: keep mine or take theirs. */
  conflicts?: Conflict[];
}

export interface Conflict {
  panelId: string;
  ref: string;
  candidate: string;
  part: 'decision' | 'summary';
  theirs: PanelDecision | WrittenSummary;
  from: string;
}

const JUDGEMENT_WORDS = (i: PanelImportItem) =>
  [
    i.added && `${i.added} judgement${i.added === 1 ? '' : 's'} added`,
    i.updated && `${i.updated} updated`,
    i.identical && `${i.identical} already here`,
    i.own && `${i.own} of your own left as they are`,
  ].filter(Boolean) as string[];

const OUTCOME_WORDS: Record<InvitationImportItem['outcome'], string> = {
  added: 'added to Upcoming',
  updated: 'updated',
  unchanged: 'already here, nothing changed',
  started: 'already started here, left as it is',
  submitted: 'already submitted here, left as it is',
  conflict: 'not added',
};

const CHANGE_WORDS: Record<string, string> = { date: 'date', time: 'time', expected: 'interviewers', note: 'note', recordingNotice: 'recording', organiser: 'organiser' };

/** TEAM-4, TEAM-5, FLOW-9: one sentence (plus lines) per imported file, in plain words (UX-8). */
export function describeImport(fileName: string, r: ImportedFileResult, today = localDay(new Date())): FileOutcome {
  if (r.kind === 'invitation') {
    const items = r.result.items;
    const added = items.filter((i) => i.outcome === 'added').length;
    const updated = items.filter((i) => i.outcome === 'updated').length;
    const parts = [added && `${added} added to Upcoming`, updated && `${updated} updated`].filter(Boolean);
    return {
      fileName,
      ok: true,
      warning: items.some((i) => i.outcome === 'conflict'),
      title: `Invitation from ${r.result.organiser}: ${items.length} interview${items.length === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.`,
      lines: items.map((i) => {
        const what = i.outcome === 'updated' && i.changed?.length ? `updated (${i.changed.map((c) => CHANGE_WORDS[c] ?? c).join(', ')})` : OUTCOME_WORDS[i.outcome];
        return `${i.candidate}, ${whenLabel(i, today)}: ${what}${i.message ? `. ${i.message}` : '.'}`;
      }),
    };
  }
  if (r.kind === 'session') {
    const who = formatNames(r.interviewers);
    const m = r.result.match;
    if (m.kind === 'none') {
      return {
        fileName,
        ok: true,
        warning: true,
        title: `${who}’s interview with ${r.candidate} was imported, but it matches no interview here.`,
        lines: [NO_MATCH_EXPLANATIONS[m.reason]],
        link: { to: `/debrief/${r.result.sessionId}`, label: 'Open it' },
      };
    }
    return {
      fileName,
      ok: true,
      title: `${who}’s interview with ${r.candidate}: matched${r.result.replaced ? ' (it replaces the copy imported before)' : ''}.`,
      lines: [],
      link: { to: `/debrief/${r.result.sessionId}`, label: 'Debrief' },
    };
  }
  if (r.kind === 'panel') {
    const items = r.result.items;
    const conflicts: Conflict[] = items.flatMap((i) => [
      ...(i.theirs.decision ? [{ panelId: i.panelId, ref: i.ref, candidate: i.candidate, part: 'decision' as const, theirs: i.theirs.decision, from: r.result.exportedBy }] : []),
      ...(i.theirs.summary ? [{ panelId: i.panelId, ref: i.ref, candidate: i.candidate, part: 'summary' as const, theirs: i.theirs.summary, from: r.result.exportedBy }] : []),
    ]);
    return {
      fileName,
      ok: true,
      warning: conflicts.length > 0 || items.some((i) => i.problem),
      title: `Panel file from ${r.result.exportedBy}: ${items.length} candidate${items.length === 1 ? '' : 's'}${conflicts.length ? `, ${conflicts.length} difference${conflicts.length === 1 ? '' : 's'} to settle` : ''}.`,
      lines: items.map((i) => {
        if (i.problem) return `${i.candidate}: not imported. ${i.problem}`;
        const parts = JUDGEMENT_WORDS(i);
        if (i.decision === 'added') parts.push('panel decision added');
        if (i.decision === 'conflict') parts.push('their panel decision differs from yours (yours kept for now)');
        if (i.summary === 'added') parts.push('written summary added');
        if (i.summary === 'conflict') parts.push('their written summary differs from yours (yours kept for now)');
        return `${i.candidate}: ${parts.length ? parts.join(', ') : 'nothing new'}.`;
      }),
      link: { to: '/summary', label: 'Open the summary' },
      conflicts,
    };
  }
  return { fileName, ok: true, title: r.alreadyPresent ? `The question set “${r.name}” is already on this device.` : `Question set “${r.name}” imported.`, lines: [] };
}

/**
 * TEAM-4, TEAM-5, FLOW-9, SEC-2: the Dashboard's one import entry point. Any number of the app's
 * files at once (invitations, interview files, question sets); each is routed by its kind and
 * validated by the repository; one summary lists what happened to each, as text.
 */
export function useImportFiles() {
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [outcomes, setOutcomes] = useState<FileOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [askName, setAskName] = useState<File[] | null>(null);
  const [name, setName] = useState('');

  const run = async (files: File[]) => {
    setBusy(true);
    const out: FileOutcome[] = [];
    for (const file of files) {
      try {
        out.push(describeImport(file.name, await importAnyFile(await readJsonFile(file))));
      } catch (err) {
        out.push({
          fileName: file.name,
          ok: false,
          title: `Not imported: ${err instanceof Error ? err.message : 'the file could not be read.'}`,
          lines: err instanceof RepoError ? err.details : [],
        });
      }
    }
    setOutcomes(out);
    setBusy(false);
    requestAnimationFrame(() => document.getElementById('import-results')?.focus());
  };

  const onFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    if (!files.length) return;
    // TEAM-4: an invitation is scored by this device's interviewer: ask for the name first if needed.
    if (!(await getInterviewerName()).trim()) {
      const kinds = await Promise.all(files.map((f) => readJsonFile(f).then(kindOf, () => null)));
      if (kinds.includes('interview-invitation')) {
        setAskName(files);
        return;
      }
    }
    await run(files);
  };

  const trigger = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="application/json,.json"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="import-input"
        onChange={(e) => onFiles(e.target.files)}
      />
      <Button ref={button} icon="upload" variant="ghost" onClick={() => input.current?.click()} disabled={busy}>
        Import files
      </Button>
      <Dialog
        open={!!askName}
        onClose={() => setAskName(null)}
        title="Your name"
        footer={
          <>
            <Button onClick={() => setAskName(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="import-name-form">
              Continue
            </Button>
          </>
        }
      >
        <form
          id="import-name-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || !askName) return;
            await setInterviewerName(name);
            const files = askName;
            setAskName(null);
            await run(files);
          }}
        >
          <Field label="Your name" hint="You will score the interviews in this invitation on this computer.">
            <TextInput value={name} onChange={(e) => setName(e.target.value.slice(0, 200))} autoComplete="name" data-autofocus />
          </Field>
        </form>
      </Dialog>
    </>
  );

  const failed = outcomes?.filter((o) => !o.ok).length ?? 0;
  const results = outcomes && (
    <section id="import-results" className="import-results card" tabIndex={-1} aria-labelledby="import-results-title" role={failed ? 'alert' : 'status'}>
      <div className="import-results__head">
        <h2 id="import-results-title">
          {outcomes.length === 1 ? 'Import' : `Imported ${outcomes.length - failed} of ${outcomes.length} files`}
          {failed > 0 && outcomes.length === 1 ? ' failed' : ''}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          icon="x"
          onClick={() => {
            setOutcomes(null);
            button.current?.focus();
          }}
        >
          Close
        </Button>
      </div>
      <ul role="list" className="import-results__list">
        {outcomes.map((o, i) => (
          <li key={i} className={`import-result import-result--${!o.ok ? 'bad' : o.warning ? 'warn' : 'ok'}`}>
            <Icon name={!o.ok ? 'x' : o.warning ? 'alert' : 'check'} />
            <div className="import-result__body">
              <p className="import-result__title">
                {o.title} {o.link && <Link to={o.link.to}>{o.link.label}</Link>}
              </p>
              {o.lines.length > 0 && (
                <ul className="import-result__lines small">
                  {o.lines.slice(0, 12).map((l, j) => (
                    <li key={j}>{l}</li>
                  ))}
                  {o.lines.length > 12 && <li>…and {o.lines.length - 12} more.</li>}
                </ul>
              )}
              {o.conflicts?.map((c) => <ConflictChoice key={`${c.panelId}-${c.part}`} conflict={c} />)}
              <p className="small muted mono import-result__file">{o.fileName}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
  return { trigger, results };
}

/**
 * TEAM-13: a panel decision or written summary in an imported panel file that differs from this
 * device's. Nothing was overwritten; the person chooses.
 */
function ConflictChoice({ conflict: c }: { conflict: Conflict }) {
  const [done, setDone] = useState<'mine' | 'theirs' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const what = c.part === 'decision' ? 'panel decision' : 'written summary';
  const theirs =
    c.part === 'decision'
      ? `${RECOMMENDATION_LABELS[(c.theirs as PanelDecision).recommendation]}: “${(c.theirs as PanelDecision).rationale}” (recorded by ${(c.theirs as PanelDecision).recordedBy})`
      : `“${(c.theirs as WrittenSummary).text.slice(0, 160)}${(c.theirs as WrittenSummary).text.length > 160 ? '…' : ''}” (by ${(c.theirs as WrittenSummary).updatedBy})`;
  return (
    <div className="import-conflict" role="group" aria-label={`Different ${what} for ${c.candidate}`} data-testid="import-conflict">
      <p className="small">
        <strong>{c.candidate}</strong>: {c.from}’s {what} is different. Theirs: <span className="pre-wrap">{theirs}</span>{' '}
        <Link to={`/candidate/${c.ref}`}>See yours</Link>
      </p>
      {done ? (
        <p className="small" role="status">
          <Icon name="check" /> {done === 'mine' ? `Kept yours.` : `Took theirs. The change is recorded in the audit log.`}
        </p>
      ) : (
        <div className="cluster">
          <Button size="sm" onClick={() => setDone('mine')}>
            Keep mine<span className="visually-hidden"> ({what}, {c.candidate})</span>
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await takeTheirs(c.panelId, c.part, c.theirs, c.from);
                setDone('theirs');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'It could not be changed.');
              }
            }}
          >
            Take theirs<span className="visually-hidden"> ({what}, {c.candidate})</span>
          </Button>
        </div>
      )}
      {error && <p className="field__error" role="alert">{error}</p>}
    </div>
  );
}
