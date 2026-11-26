import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { exportTrackCsv, hasPermission, setQuestionStatus, useMe, useTrackBank, useTracks } from '../db';
import { filterQuestions } from '../domain/plan';
import type { Question } from '../domain/types';
import { Badge, Button, Dialog, DocLink, EmptyState, IconButton, PageHeader, QuestionTags, downloadFile, formatMinutes, useDocumentTitle, useToast } from '../ui';
import { QuestionDetailDialog } from './bank/QuestionDetail';
import { QuestionFilters } from './bank/QuestionFilters';
import { TagLegend } from './bank/TagLegend';
import { QuestionEditor, type EditorMode } from './bank/QuestionEditor';
import { BulkAddDialog } from './bank/BulkAddDialog';
import { CategoryManager, NewTrackDialog } from './bank/CategoryManager';
import { ExportTrackDialog, ImportQuestions, UnexportedBadge } from './bank/TrackFiles';
import { EMPTY_FILTERS, resultSummary, toQuestionFilter, type FilterState } from './bank/filters';
import '../styles/pages/bank.css';

/**
 * Routes: /bank, /bank/:trackId. Browse (BANK-2) and manage (BANK-9…BANK-14) the question bank,
 * which lives in the database and is shared by everyone (DB-1). Interviewers read it; organisers
 * and administrators edit it (USER-2); the server checks every change.
 */
export default function QuestionBank() {
  useDocumentTitle('Question bank');
  const { trackId: routeTrackId } = useParams();
  const tracks = useTracks();
  const me = useMe();
  const canEdit = hasPermission(me, 'bank.edit');
  const trackId = routeTrackId ?? tracks?.[0]?.id;
  const [newTrack, setNewTrack] = useState(false);
  const [exportId, setExportId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Question bank"
        subtitle={canEdit ? 'Browse, add and edit the questions for each role. Changes are saved for everyone straight away.' : 'Browse the questions for each role.'}
        actions={
          canEdit ? (
            <Button icon="plus" onClick={() => setNewTrack(true)}>
              New track…
            </Button>
          ) : undefined
        }
      />
      {canEdit && (
        <p className="small muted bank-intro">
          Interviews already set up keep the questions as they were. <DocLink req="BANK-11" label="How question versions work" />
        </p>
      )}
      {tracks && tracks.length > 0 && (
        <nav className="bank-tracks" aria-label="Tracks">
          <ul role="list">
            {tracks.map((t) => (
              <li key={t.id}>
                <NavLink to={`/bank/${t.id}`} aria-current={t.id === trackId ? 'page' : undefined} className={t.id === trackId ? 'active' : undefined}>
                  {t.name}
                  {canEdit && t.changedAt && (
                    <span className="bank-tracks__mark" title="Not exported">
                      {' '}
                      ●<span className="visually-hidden"> (changes not exported)</span>
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {tracks === undefined ? (
        <p className="muted">Loading…</p>
      ) : trackId ? (
        <TrackBrowser key={trackId} trackId={trackId} onExport={setExportId} canEdit={canEdit} canImport={hasPermission(me, 'bank.import')} />
      ) : (
        <EmptyState title="There are no questions yet." actions={canEdit ? <Button onClick={() => setNewTrack(true)}>New track…</Button> : undefined}>
          <p>{canEdit ? 'Create a track, or ask an administrator to import the question files.' : 'Ask an administrator to import the question files.'}</p>
        </EmptyState>
      )}
      <NewTrackDialog open={newTrack} onClose={() => setNewTrack(false)} />
      <ExportTrackDialog trackId={exportId} onClose={() => setExportId(null)} />
    </>
  );
}

function TrackBrowser({ trackId, onExport, canEdit, canImport }: { trackId: string; onExport: (trackId: string) => void; canEdit: boolean; canImport: boolean }) {
  const bank = useTrackBank(trackId);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS });
  const [openId, setOpenId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [dialog, setDialog] = useState<'bulk' | 'categories' | 'import' | null>(null);

  const categoryName = useMemo(() => new Map((bank?.categories ?? []).map((c) => [c.id, c.name])), [bank]);
  const all = useMemo(() => bank?.questions ?? [], [bank]);
  const shown = useMemo(() => filterQuestions(all, toQuestionFilter(filters, { allowRetired: true })), [all, filters]);
  const totalVisible = filters.includeRetired ? all.length : all.filter((q) => q.status !== 'retired').length;

  if (bank === undefined) return <p className="muted">Loading questions…</p>;
  if (bank === null) {
    return (
      <EmptyState title="Track not found.">
        <p>Choose one of the tracks above.</p>
      </EmptyState>
    );
  }

  const index = openId ? shown.findIndex((q) => q.id === openId) : -1;
  const open = openId ? (all.find((q) => q.id === openId) ?? null) : null;
  const retired = all.filter((q) => q.status === 'retired').length;

  const setStatus = async (q: Question, status: Question['status']) => {
    try {
      await setQuestionStatus(q.id, status);
      toast(
        status === 'retired' ? `Question ${q.number} retired. It is no longer offered when building a plan.` : `Question ${q.number} restored. It is offered when building a plan again.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the question.', 'error');
    }
  };

  const exportCsv = async () => {
    try {
      const f = await exportTrackCsv(trackId);
      downloadFile(f.fileName, f.mime, f.text);
      toast(`Exported the active questions as ${f.fileName}. Recorded in the audit log.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The export failed.', 'error');
    }
  };

  return (
    <section aria-labelledby="bank-track-title" className="stack">
      <div className="bank-track-head">
        <div>
          <h2 id="bank-track-title">{bank.track.name}</h2>
          <p className="small muted">
            <span className="mono">{bank.track.id}</span> · version {bank.track.version} · {all.length - retired} active questions{retired ? ` · ${retired} retired` : ''} ·{' '}
            {bank.categories.length} categories
          </p>
        </div>
        {canEdit && bank.changedAt && (
          <div className="cluster">
            <UnexportedBadge changedAt={bank.changedAt} />
            <DocLink req="BANK-14" />
          </div>
        )}
        {!canEdit && (
          <Button icon="download" variant="ghost" onClick={exportCsv}>
            Export CSV
          </Button>
        )}
      </div>
      {canEdit ? (
      <div className="bank-toolbar" role="group" aria-label="Manage this track">
        <div className="cluster">
          <Button variant="primary" icon="plus" onClick={() => setEditor({ kind: 'add', categoryId: filters.categoryId || undefined })}>
            Add question
          </Button>
          <Button icon="upload" onClick={() => setDialog('bulk')}>
            Bulk add…
          </Button>
          <Button icon="folder" onClick={() => setDialog('categories')}>
            Categories…
          </Button>
        </div>
        <div className="cluster">
          <Button icon="download" onClick={() => onExport(trackId)}>
            Export track file…
          </Button>
          <Button icon="download" variant="ghost" onClick={exportCsv}>
            Export CSV
          </Button>
          {canImport && (
            <Button icon="upload" variant="ghost" onClick={() => setDialog('import')}>
              Import files…
            </Button>
          )}
        </div>
      </div>
      ) : null}
      {all.length === 0 ? (
        <EmptyState
          title="This track has no questions yet."
          actions={
            canEdit && <>
              <Button variant="primary" icon="plus" onClick={() => setEditor({ kind: 'add' })}>
                Add question
              </Button>
              <Button icon="upload" onClick={() => setDialog('bulk')}>
                Bulk add…
              </Button>
            </>
          }
        >
          {canEdit && <p>Add them one by one, or paste them from a spreadsheet.</p>}
        </EmptyState>
      ) : (
        <>
          <QuestionFilters idPrefix="bank" value={filters} onChange={setFilters} categories={bank.categories} allowRetired={retired > 0} />
          <div className="spread bank-summary">
            <p className="small" role="status" aria-live="polite" aria-atomic="true">
              <strong>{resultSummary(shown.length, totalVisible)}</strong>
            </p>
            <TagLegend />
          </div>
          {shown.length === 0 ? (
            <EmptyState title="No questions match these filters.">
              <p>Try fewer filters or a different search.</p>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table bank-table pc-rtable">
                <caption className="visually-hidden">Questions in {bank.track.name}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      No.
                    </th>
                    <th scope="col">Question</th>
                    <th scope="col">Category</th>
                    <th scope="col">Tags</th>
                    <th scope="col" className="num">
                      Time
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((q) => (
                    <BankRow key={q.id} q={q} category={categoryName.get(q.categoryId) ?? q.categoryId} onOpen={() => setOpenId(q.id)} onEdit={canEdit ? () => setEditor({ kind: 'edit', question: q }) : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <QuestionDetailDialog
        question={open}
        categoryName={open ? (categoryName.get(open.categoryId) ?? open.categoryId) : ''}
        onClose={() => setOpenId(null)}
        position={
          index >= 0
            ? {
                index,
                total: shown.length,
                onPrev: () => index > 0 && setOpenId(shown[index - 1].id),
                onNext: () => index < shown.length - 1 && setOpenId(shown[index + 1].id),
              }
            : undefined
        }
        extraFooter={
          open && canEdit && (
            <div className="cluster">
              <Button size="sm" icon="edit" onClick={() => setEditor({ kind: 'edit', question: open })}>
                Edit
              </Button>
              <Button size="sm" icon="copy" onClick={() => setEditor({ kind: 'duplicate', from: open })}>
                Duplicate
              </Button>
              {open.status === 'active' ? (
                <Button size="sm" icon="archive" onClick={() => setStatus(open, 'retired')}>
                  Retire
                </Button>
              ) : (
                <Button size="sm" icon="undo" onClick={() => setStatus(open, 'active')}>
                  Restore
                </Button>
              )}
            </div>
          )
        }
      />
      <QuestionEditor
        mode={editor}
        trackId={trackId}
        categories={bank.categories}
        onClose={() => setEditor(null)}
        onSaved={(r, mode) => {
          setEditor(null);
          if (mode.kind === 'edit') {
            toast(r.changed ? `Question ${r.number} saved${r.bumped ? `; it is now version ${r.version}` : ''}.` : `Question ${r.number}: nothing changed.`, 'success');
          } else {
            toast(`Question ${r.number} added.`, 'success');
            if (openId) setOpenId(r.id); // a duplicate made from the open question: show the new one
          }
        }}
      />
      <BulkAddDialog open={dialog === 'bulk'} trackId={trackId} trackName={bank.track.name} categories={bank.categories} questions={all} onClose={() => setDialog(null)} />
      <CategoryManager open={dialog === 'categories'} onClose={() => setDialog(null)} trackId={trackId} trackName={bank.track.name} categories={bank.categories} questions={all} />
      <Dialog open={dialog === 'import'} onClose={() => setDialog(null)} wide title="Import question files" footer={<Button onClick={() => setDialog(null)}>Close</Button>}>
        <ImportQuestions
          onImported={(ids) => {
            setDialog(null);
            if (ids.length === 1 && ids[0] !== trackId) navigate(`/bank/${ids[0]}`);
          }}
        />
      </Dialog>
    </section>
  );
}

function BankRow({ q, category, onOpen, onEdit }: { q: Question; category: string; onOpen: () => void; onEdit?: () => void }) {
  return (
    <tr className={q.status === 'retired' ? 'bank-row--retired' : undefined}>
      <td className="num" data-label="No.">
        {q.number}
      </td>
      <td data-label="Question" className="bank-table__text">
        <div>
          <button type="button" className="pc-linkbtn" onClick={onOpen} aria-haspopup="dialog">
            {q.text}
          </button>
          {q.status === 'retired' && (
            <>
              {' '}
              <Badge tone="warning" icon="archive">
                Retired
              </Badge>
            </>
          )}
        </div>
      </td>
      <td data-label="Category">{category}</td>
      <td data-label="Tags">
        <QuestionTags question={q} />
      </td>
      <td className="num" data-label="Time">
        {formatMinutes(q.timeMin)}
      </td>
      <td className="pc-rtable__actions">
        {onEdit && <IconButton icon="edit" size="sm" label={`Edit question ${q.number}`} onClick={onEdit} aria-haspopup="dialog" />}
      </td>
    </tr>
  );
}
