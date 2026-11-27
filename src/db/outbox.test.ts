import { describe, expect, it } from 'vitest';
import { Outbox, compact, nextBatch, type PendingOp } from './outbox';
import type { RecordOp } from '../shared/api';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const op = (i: number): RecordOp => ({ t: 'kp', q: 'q1', i, on: true });
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(fail: () => 'ok' | 'network' | 'refused' = () => 'ok') {
  const storage = new MemStorage();
  const sent: Array<{ recordId: string; ops: RecordOp[] }> = [];
  const timers: Array<() => void> = [];
  const dropped: string[] = [];
  const make = () =>
    new Outbox({
      storage,
      key: 'k',
      send: async (recordId, ops) => {
        const f = fail();
        if (f === 'network') throw new Error('network');
        if (f === 'refused') throw new Error('refused');
        sent.push({ recordId, ops });
        return { recordId };
      },
      classify: (err) => ((err as Error).message === 'refused' ? 'drop' : 'retry'),
      onDropped: (r) => dropped.push(r),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
  return { storage, sent, timers, dropped, make };
}

describe('the outbox (HOST-6, RES-1, RES-3)', () => {
  it('HOST-6 RES-1: changes are sent in the order they were made, in batches per record', async () => {
    const h = harness();
    const box = h.make();
    box.add('r1', [op(0), op(1)]);
    box.add('r2', [op(2)]);
    box.add('r1', [op(3)]);
    await box.drained();
    expect(h.sent.map((s) => [s.recordId, s.ops.map((o) => (o as { i: number }).i)])).toEqual([
      ['r1', [0, 1]],
      ['r2', [2]],
      ['r1', [3]],
    ]);
    expect(box.getSnapshot()).toEqual({ state: 'saved', pending: [] });
    expect(h.storage.data.size).toBe(0); // nothing is kept once it is sent
  });

  it('HOST-6 RES-3: while the server cannot be reached, changes wait (kept in storage) and the state says offline; they go when it can', async () => {
    let down = true;
    const h = harness(() => (down ? 'network' : 'ok'));
    const box = h.make();
    box.add('r1', [op(0)]);
    await tick();
    box.add('r1', [op(1)]);
    await tick();
    expect(box.getSnapshot().state).toBe('offline');
    expect(box.getSnapshot().pending).toHaveLength(2);
    expect(JSON.parse(h.storage.getItem('k')!)).toHaveLength(2);
    // A reload: a new outbox finds them.
    expect(h.make().getSnapshot().pending.map((p) => (p.op as { i: number }).i)).toEqual([0, 1]);
    down = false;
    h.timers.shift()!(); // the retry timer fires
    await box.drained();
    expect(h.sent).toEqual([{ recordId: 'r1', ops: [op(0), op(1)] }]);
    expect(box.getSnapshot().state).toBe('saved');
  });

  it('HOST-6: a batch the server refuses for good is dropped and reported, and the rest still goes', async () => {
    let first = true;
    const h = harness(() => (first ? ((first = false), 'refused') : 'ok'));
    const box = h.make();
    box.add('r1', [op(0)]);
    await tick();
    box.add('r1', [op(1)]);
    await box.drained();
    expect(h.dropped).toEqual(['r1']);
    expect(h.sent).toEqual([{ recordId: 'r1', ops: [op(1)] }]);
  });

  it('RES-1: typing while offline queues a few changes, not one per keystroke: consecutive edits of one note collapse', () => {
    const p = (seq: number, o: RecordOp, recordId = 'r1'): PendingOp => ({ seq, recordId, op: o, at: 0 });
    const ops = [
      p(1, { t: 'note.add', id: 'n', q: 'q', atSec: 1, text: 'a', by: null }),
      p(2, { t: 'note.edit', id: 'n', text: 'ab' }),
      p(3, { t: 'note.edit', id: 'n', text: 'abc', by: 'Ana' }),
      p(4, { t: 'note.edit', id: 'n', text: 'abcd' }),
      p(5, op(0)),
      p(6, { t: 'note.edit', id: 'n', text: 'abcde' }),
    ];
    const c = compact(ops);
    expect(c.map((x) => x.seq)).toEqual([1, 4, 5, 6]);
    expect(c[1].op).toEqual({ t: 'note.edit', id: 'n', text: 'abcd', by: 'Ana' });
    expect(nextBatch([p(1, op(0)), p(2, op(1), 'r2'), p(3, op(2))]).map((x) => x.seq)).toEqual([1]);
  });

  it('HOST-1: very old leftovers are not sent', () => {
    const h = harness();
    h.storage.setItem('k', JSON.stringify([{ seq: 1, recordId: 'r', op: op(0), at: Date.now() - 8 * 24 * 3600_000 }, { seq: 2, recordId: 'r', op: op(1), at: Date.now() }]));
    expect(h.make().getSnapshot().pending.map((p) => p.seq)).toEqual([2]);
  });
});
