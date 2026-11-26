import { useMemo, useState } from 'react';
import { AUDIT_ACTION_LABELS, exportAuditCsv, useAuditEvents } from '../../db';
import type { AuditAction, AuditEvent } from '../../domain/types';
import { Button, DocLink, EmptyState, Field, Select, TextInput, downloadFile, formatDateTime, useToast } from '../../ui';
import { auditEntityText, auditValueText, toAuditFilter, type AuditFilterForm } from './model';

const PAGE = 100;
const EMPTY: AuditFilterForm = { action: '', from: '', to: '', text: '' };

/** AUD-1, AUD-2, AUD-3: view, filter and export the append-only audit log. */
export function AuditLog() {
  const [form, setForm] = useState<AuditFilterForm>(EMPTY);
  const [shown, setShown] = useState(PAGE);
  const filter = useMemo(() => toAuditFilter(form), [form]);
  const events = useAuditEvents(filter);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AuditFilterForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setShown(PAGE);
  };
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
        Every plan lock, start, submission, edit after submission, export, import, bank reload, retention purge and privacy
        request is recorded here. The log is append-only: entries cannot be edited or deleted. <DocLink req="AUD-1" />{' '}
        <DocLink req="AUD-2" />
      </p>

      <form className="adm-filters" role="search" aria-label="Filter the audit log" onSubmit={(e) => e.preventDefault()}>
        <Field label="Action">
          <Select
            value={form.action}
            onChange={(e) => set({ action: e.target.value as AuditAction | '' })}
            placeholder="All actions"
            options={(Object.keys(AUDIT_ACTION_LABELS) as AuditAction[]).map((a) => ({ value: a, label: AUDIT_ACTION_LABELS[a] }))}
          />
        </Field>
        <Field label="From (date)">
          <TextInput type="date" value={form.from} onChange={(e) => set({ from: e.target.value })} />
        </Field>
        <Field label="To (date)">
          <TextInput type="date" value={form.to} onChange={(e) => set({ to: e.target.value })} />
        </Field>
        <Field label="Search" hint="Actor, action, entity id or reason.">
          <TextInput type="search" value={form.text} onChange={(e) => set({ text: e.target.value })} />
        </Field>
        <div className="adm-filters__actions">
          <Button onClick={() => set(EMPTY)} disabled={!filtered}>
            Clear filters
          </Button>
          <Button icon="download" onClick={exportCsv} disabled={busy || !events?.length}>
            Export CSV
          </Button>
        </div>
      </form>

      <p className="small muted" aria-live="polite">
        {events === undefined
          ? 'Loading…'
          : `${events.length} entr${events.length === 1 ? 'y' : 'ies'}${filtered ? ' match the filters' : ''}, newest first.${filtered ? ' The CSV export uses the same filters.' : ''}`}{' '}
        <DocLink req="AUD-3" />
      </p>

      {events && events.length === 0 ? (
        <EmptyState title={filtered ? 'No entries match these filters.' : 'The audit log is empty.'} />
      ) : events ? (
        <>
          <div className="table-wrap">
            <table className="table table--compact adm-audit">
              <caption className="visually-hidden">Audit log</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Before / after</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, shown).map((e) => (
                  <AuditRow key={e.id} event={e} />
                ))}
              </tbody>
            </table>
          </div>
          {events.length > shown && (
            <p>
              <Button onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, events.length - shown)} more ({events.length - shown} not shown)
              </Button>
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

function AuditRow({ event: e }: { event: AuditEvent }) {
  const before = auditValueText(e.before);
  const after = auditValueText(e.after);
  return (
    <tr>
      <td className="nowrap tabular">
        <time dateTime={e.ts}>{formatDateTime(e.ts)}</time>
      </td>
      <td>{e.actor}</td>
      <td className="nowrap">{AUDIT_ACTION_LABELS[e.action] ?? e.action}</td>
      <td className="nowrap">
        <span title={e.entityId ?? undefined}>{auditEntityText(e)}</span>
      </td>
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
