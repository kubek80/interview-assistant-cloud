import { useRef, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader, useDocumentTitle } from '../ui';
import { AuditLog } from './admin/AuditLog';
import { BankFiles } from './admin/BankFiles';
import { Settings } from './admin/Settings';
import '../styles/pages/admin.css';

const TABS = [
  { id: 'audit', label: 'Audit log', render: () => <AuditLog /> },
  { id: 'bank', label: 'Question files', render: () => <BankFiles /> },
  { id: 'settings', label: 'Settings', render: () => <Settings /> },
  // Privacy requests and the AI second opinion come with steps 2 and 3 of the hosted build.
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Route: /admin, for administrators (HPRIV-4, AUD-3, DB-3). */
export default function Admin() {
  useDocumentTitle('Admin');
  const [params, setParams] = useSearchParams();
  const current: TabId = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'audit') as TabId;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: TabId, focus = false) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
    if (focus) refs.current[id]?.focus();
  };

  // WAI-ARIA tabs pattern: arrow keys move between tabs, Home/End jump (A11Y-1).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === current);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TABS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    select(TABS[j].id, true);
  };

  const tab = TABS.find((t) => t.id === current)!;
  return (
    <div className="admin">
      <PageHeader title="Admin" subtitle="The audit log, question files and settings for everyone." />
      <div role="tablist" aria-label="Admin sections" className="adm-tabs" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`adm-tab-${t.id}`}
            aria-selected={t.id === current}
            aria-controls={`adm-panel-${t.id}`}
            tabIndex={t.id === current ? 0 : -1}
            className="adm-tab"
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`adm-panel-${tab.id}`} aria-labelledby={`adm-tab-${tab.id}`} className="adm-panel" tabIndex={0}>
        <h2 className="adm-panel__title">{tab.label}</h2>
        {tab.render()}
      </div>
    </div>
  );
}
