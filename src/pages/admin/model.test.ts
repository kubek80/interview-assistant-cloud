import { describe, expect, it } from 'vitest';
import { auditEntityText, auditValueText, bankCounts, daysBetween, retentionStatus, toAuditFilter } from './model';

describe('Admin helpers', () => {
  it('PRIV-5: a session is expired only after its retention date (matches purgeExpired "below today")', () => {
    expect(retentionStatus('2026-11-23', '2026-11-24')).toMatchObject({ expired: true, daysLeft: -1, label: 'Expired 1 day ago' });
    expect(retentionStatus('2026-11-24', '2026-11-24')).toMatchObject({ expired: false, daysLeft: 0, label: 'Last day today' });
    expect(retentionStatus('2027-02-22', '2026-11-24')).toMatchObject({ expired: false, daysLeft: 90 });
  });

  it('PRIV-5: day counts are calendar days, unaffected by daylight saving changes', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('AUD-1: entity text shortens random ids and keeps track ids', () => {
    expect(auditEntityText({ entity: 'session', entityId: '3f9a1c2b-0000-4000-8000-000000000000' })).toBe('Interview 3f9a1c2b');
    expect(auditEntityText({ entity: 'track', entityId: 'aks' })).toBe('Question bank track aks');
    expect(auditEntityText({ entity: 'device', entityId: null })).toBe('This device');
  });

  it('AUD-1: before/after values are shown as JSON text (SEC-2)', () => {
    expect(auditValueText(null)).toBeNull();
    expect(auditValueText({ score: 3 })).toBe('{\n  "score": 3\n}');
    expect(auditValueText('<b>x</b>')).toBe('<b>x</b>');
  });

  it('AUD-3: the filter form maps to the repository filter; empty fields mean any', () => {
    expect(toAuditFilter({ action: '', from: '', to: '', text: '  ' })).toEqual({});
    expect(toAuditFilter({ action: 'export', from: '2026-11-01', to: '2026-11-24', text: ' alice ' })).toEqual({
      actions: ['export'],
      from: new Date(2026, 10, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 10, 24, 23, 59, 59, 999).toISOString(),
      text: 'alice',
    });
  });

  it('BANK-7: counts active and retired questions', () => {
    expect(bankCounts([{ status: 'active' }, { status: 'retired' }, { status: 'active' }])).toEqual({ total: 3, active: 2, retired: 1 });
  });
});
