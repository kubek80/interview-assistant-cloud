import { useMemo, useState } from 'react';
import { AUDIT_ACTION_LABELS, exportAuditCsv, useAuditLog } from '../../db';
import type { AuditEntry } from '../../shared/api';
import type { AuditEntity } from '../../domain/types';
import { Button, DocLink, EmptyState, Field, Select, TextInput, downloadFile, formatDateTime, useToast } from '../../ui';
import { auditEntityText, auditValueText, toAuditFilter, type AuditFilterForm } from './model';

const EMPTY: AuditFilterForm = { action: '', from: '', to: '', text: '' };

/** HPRIV-4, AUD-3: view, filter and export the audit log kept in the database. */
export function AuditLog() {
  const [form, setForm] = useState<AuditFilterForm>(EMPTY);
  const filter = useMemo(() => toAuditFilter(form), [form]);
  const { entries, hasMore, loadMore, loadingMore } = useAuditLog(filter);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AuditFilterForm>) => setForm((f) => ({ ...f, ...patch }));
  const filtered = !!(form.action || form.from || form.to || form.text.trim());

  const exportCsv = async () => {
    setBusy(true);
    try {
      const f = await exportAuditCsv(filter);
      downloadFile(f.fileName, f.mime, f.text);
      toast('Audit log exported as CSV. The export itself is recorded in the log.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p>
        Every change to people, the question bank and settings, every sign-in and every export is recorded here, with who did it and when. Entries cannot be
        changed or deleted. <DocLink req="HPRIV-4" />
      </p>
      <form className="adm-filters" role="search" aria-label="Filter the audit log" onSubmit={(e) => e.preventDefault()}>
        <Field label="Action">
          <Select value={form.action} onChange={(e) => set({ action: e.target.value })} placeholder="All actions" options={Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="From (date)">
          <TextInput type="date" value={form.from} onChange={(e) => set({ from: e.target.value })} />
        </Field>
        <Field label="To (date)">
          <TextInput type="date" value={form.to} onChange={(e) => set({ to: e.target.value })} />
        </Field>
        <Field label="Search" hint="Person, action, item or reason.">
          <TextInput type="search" value={form.text} onChange={(e) => set({ text: e.target.value })} />
        </Field>
        <div className="adm-filters__actions">
          <Button onClick={() => set(EMPTY)} disabled={!filtered}>
            Clear filters
          </Button>
          <Button icon="download" onClick={exportCsv} disabled={busy || !entries?.length}>
            Export CSV
          </Button>
        </div>
      </form>
      <p className="small muted" aria-live="polite">
        {entries === undefined ? 'Loading…' : `${entries.length}${hasMore ? '+' : ''} entr${entries.length === 1 ? 'y' : 'ies'}${filtered ? ' match the filters' : ''}, newest first.`}
      </p>
      {entries && entries.length === 0 ? (
        <EmptyState title={filtered ? 'No entries match these filters.' : 'The audit log is empty.'} />
      ) : entries ? (
        <>
          <div className="table-wrap">
            <table className="table table--compact adm-audit">
              <caption className="visually-hidden">Audit log</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Item</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Before / after</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <AuditRow key={e.id} entry={e} />
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <p>
              <Button onClick={loadMore} disabled={loadingMore}>
                Show more
              </Button>
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

function AuditRow({ entry: e }: { entry: AuditEntry }) {
  const before = auditValueText(e.before);
  const after = auditValueText(e.after);
  return (
    <tr>
      <td className="nowrap tabular">
        <time dateTime={e.at}>{formatDateTime(e.at)}</time>
      </td>
      <td>{e.actor}</td>
      <td className="nowrap">{AUDIT_ACTION_LABELS[e.action] ?? e.action}</td>
      <td className="nowrap">{auditEntityText({ entity: e.entity as AuditEntity, entityId: e.entityId })}</td>
      <td className="pre-wrap">{e.reason ?? <span className="muted">–</span>}</td>
      <td>
        {before || after ? (
          <details className="adm-details">
            <summary>Show values</summary>
            <div className="adm-values">
              {before && (
                <div>
                  <p className="small muted">Before</p>
                  <pre>{before}</pre>
                </div>
              )}
              {after && (
                <div>
                  <p className="small muted">After</p>
                  <pre>{after}</pre>
                </div>
              )}
            </div>
          </details>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
    </tr>
  );
}
