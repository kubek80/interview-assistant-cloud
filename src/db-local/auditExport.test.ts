import { beforeEach, describe, expect, it } from 'vitest';
import { db, exportAuditCsv, queryAudit, setInterviewerName } from '../../db';
import { toAuditFilter } from './model';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('Admin audit export', () => {
  it('AUD-3, FLOW-32: exporting the filtered audit log as CSV works and is itself audited', async () => {
    await setInterviewerName('Alice');
    const first = await exportAuditCsv(toAuditFilter({ action: '', from: '', to: '', text: '' }));
    expect(first.text.split('\r\n')[0]).toBe('Id,Time,Actor,Action,Entity,Entity id,Before,After,Reason');
    const second = await exportAuditCsv(toAuditFilter({ action: 'export', from: '', to: '', text: 'alice' }));
    expect(second.text.trim().split('\r\n')).toHaveLength(2); // header + the first export
    const events = await queryAudit({ actions: ['export'] });
    expect(events.map((e) => (e.after as { format: string }).format)).toEqual(['audit-csv', 'audit-csv']);
  });
});
