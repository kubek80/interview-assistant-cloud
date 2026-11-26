import { useRef, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader, useDocumentTitle } from '../ui';
import { AuditLog } from './admin/AuditLog';
import { Privacy } from './admin/Privacy';
import { BankAdmin } from './admin/BankAdmin';
import { Device } from './admin/Device';
import { AiAdmin } from './admin/AiAdmin';
import '../styles/pages/admin.css';

const TABS = [
  { id: 'audit', label: 'Audit log', render: () => <AuditLog /> },
  { id: 'privacy', label: 'Privacy', render: () => <Privacy /> },
  { id: 'bank', label: 'Question bank', render: () => <BankAdmin /> },
  { id: 'device', label: 'This device', render: () => <Device /> },
  { id: 'ai', label: 'AI second opinion', render: () => <AiAdmin /> },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Route: /admin (PRIV-5, PRIV-6, AUD-1…AUD-3, BANK-7, AI-2). */
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
      <PageHeader title="Admin" subtitle="Audit log, privacy requests, the question bank, this device’s settings and the optional AI second opinion." />
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
