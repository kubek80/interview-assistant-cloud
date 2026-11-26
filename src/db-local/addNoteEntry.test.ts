import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addNoteEntry, createPlan, db, deleteNote, editNote, loadSeeds, lockPlan, pauseSession, confirmConsent, startSession, updatePlanDraft } from '../../db';
import { clock } from '../../db/util';
import { makeTrackFile } from '../../test/fixtures';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => now;
  await db.delete();
  await db.open();
  await loadSeeds([makeTrackFile('tt', '2026.11', 3)]);
});
afterEach(() => {
  clock.now = realNow;
});

async function started() {
  const planId = await createPlan('tt');
  await updatePlanDraft(planId, { questionIds: ['tt-1', 'tt-2'] });
  const { sessionId } = await lockPlan(planId, {
    initials: 'ab',
    requisitionId: null,
    interviewerName: 'Pat',
    retentionUntil: '2027-02-22',
  });
  await confirmConsent(sessionId);
  await startSession(sessionId);
  return sessionId;
}

describe('addNoteEntry (FLOW-15, RES-1: a note is saved while it is typed)', () => {
  it('FLOW-15: returns the new index and stamps the elapsed interview time; editNote then updates it in place', async () => {
    const id = await started();
    now += 65_000;
    expect(await addNoteEntry(id, 'tt-1', 'Talks ab')).toBe(0);
    now += 5_000;
    await editNote(id, 'tt-1', 0, 'Talks about retries');
    expect(await addNoteEntry(id, 'tt-1', 'second')).toBe(1);
    const a = await db.answers.get([id, 'tt-1']);
    expect(a?.notes).toEqual([
      { atSec: 65, text: 'Talks about retries' },
      { atSec: 70, text: 'second' },
    ]);
    await deleteNote(id, 'tt-1', 0);
    expect((await db.answers.get([id, 'tt-1']))?.notes).toEqual([{ atSec: 70, text: 'second' }]);
  });

  it('RES-1: empty text adds nothing; FLOW-21: the stamp does not advance while paused', async () => {
    const id = await started();
    expect(await addNoteEntry(id, 'tt-1', '   ')).toBeNull();
    now += 10_000;
    await pauseSession(id);
    now += 60_000;
    expect(await addNoteEntry(id, 'tt-2', 'during pause')).toBe(0);
    expect((await db.answers.get([id, 'tt-2']))?.notes).toEqual([{ atSec: 10, text: 'during pause' }]);
  });
});
