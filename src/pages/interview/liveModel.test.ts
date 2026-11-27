import { describe, expect, it } from 'vitest';
import { leadChangeMessage, panelMarks, panelSummary, peopleChips, savingLine, waitingLine } from './liveModel';
import type { LiveState, OtherRecord } from '../../shared/api';

const panel: LiveState['panel'] = [
  { id: 'a', name: 'Ana Diaz', status: 'joined', recordId: 'ra', recordState: 'draft', onRecordOf: null, seenAt: 10_000 },
  { id: 'b', name: 'Ben Ng', status: 'joined', recordId: 'rb', recordState: 'draft', onRecordOf: null, seenAt: null },
  { id: 'c', name: 'Cy Park', status: 'expected', recordId: null, recordState: null, onRecordOf: null, seenAt: null },
  { id: 'd', name: 'Dee', status: 'joined', recordId: null, recordState: null, onRecordOf: 'a', seenAt: null },
];

describe('the live screen’s model (LIVE-2, LIVE-3, LIVE-4, RES-3)', () => {
  it('LIVE-2 LIVE-3: the people line says who is here, who leads, and where the others are', () => {
    const chips = peopleChips({ panel, leadUserId: 'a' }, 'b', 20_000);
    expect(chips.map((c) => [c.initials, c.present, c.leading, c.isMe, c.note])).toEqual([
      ['AD', true, true, false, 'here'],
      ['BN', false, false, true, 'away'],
      ['CP', false, false, false, 'not joined yet'],
      // Sharing Ana's screen: present when Ana is.
      ['DE', true, false, false, 'on Ana Diaz’s screen'],
    ]);
  });

  it('LIVE-2: the lead changing is said once, to the right people', () => {
    const name = (id: string) => ({ a: 'Ana', b: 'Ben' })[id] ?? '?';
    expect(leadChangeMessage(undefined, 'a', 'b', name)).toBeNull(); // first load
    expect(leadChangeMessage('a', 'a', 'b', name)).toBeNull();
    expect(leadChangeMessage('a', 'b', 'b', name)).toMatch(/^You are leading now/);
    expect(leadChangeMessage('b', 'a', 'b', name)).toBe('Ana took the lead. Your Next and Previous now only change what you see.');
    expect(leadChangeMessage('a', 'c', 'b', name)).toBe('? is leading now.');
  });

  it('LIVE-3: each other member’s marks for one question; hidden ones say only whether they have scored', () => {
    const q = { id: 'q1', lookFor: ['Label: one', 'two'], redFlags: ['bad'] };
    const others: OtherRecord[] = [
      { id: 'rb', ownerId: 'b', names: ['Ben Ng'], state: 'draft', resolved: ['q1'], marks: { answers: [{ questionId: 'q1', score: 3, coveredKeyPoints: [0], redFlagsSeen: [0], probeHandled: true, flagged: false, skipped: false, skipReason: null }], notes: [{ id: 'n', questionId: 'q1', atSec: 4, text: 'hi', by: null }], overall: { rating: null, recommendation: null, rationale: '' } } },
      { id: 'rc', ownerId: 'c', names: ['Cy Park', 'Dee'], state: 'draft', resolved: [], marks: null },
    ];
    const m = panelMarks(q, others);
    expect(m[0]).toMatchObject({ score: 3, keyPoints: ['Label: one'], redFlags: ['bad'], probeHandled: true, hidden: false, resolved: true });
    expect(m[0].notes.map((n) => n.text)).toEqual(['hi']);
    expect(m[1]).toMatchObject({ hidden: true, resolved: false, score: null });
    expect(panelSummary(m)).toBe('Ben 3 · Cy +1 not yet');
  });

  it('LIVE-4: the interview waits for those who joined and have not submitted', () => {
    expect(waitingLine(panel)).toBe('Waiting for Ana Diaz, Ben Ng and Dee');
    expect(waitingLine(panel, 'a')).toBe('Waiting for Ben Ng and Dee');
    expect(waitingLine(panel.map((p) => ({ ...p, status: 'submitted' as const })))).toBeNull();
  });

  it('RES-3 HOST-6: the header says plainly whether everything is saved, being saved, or kept here while offline', () => {
    expect(savingLine('saved', 0, 'live', true)).toEqual({ tone: 'ok', text: 'All changes saved' });
    expect(savingLine('saving', 2, 'live', true)).toEqual({ tone: 'busy', text: 'Saving…' });
    expect(savingLine('offline', 3, 'connecting', true)).toEqual({ tone: 'warn', text: 'Offline · 3 changes kept on this computer' });
    expect(savingLine('saved', 0, 'offline', false)).toEqual({ tone: 'warn', text: 'Offline · nothing waiting to be saved' });
    expect(savingLine('saving', 1, 'connecting', true).text).toBe('Reconnecting · saving your changes');
  });
});
