// HOST-5: live updates go through the database, so every instance delivers what any instance publishes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, client, createTestDb, signIn, startApp, type TestApp, type TestDb } from '../test/harness';
import { LiveBus, publish } from './bus';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t.drop());

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('LISTEN/NOTIFY bus', () => {
  it('HOST-5: an event published on one instance reaches subscribers on another, only once the change commits', async () => {
    const a = new LiveBus({ connectionString: t.url }, { warn: () => {}, info: () => {} });
    const b = new LiveBus({ connectionString: t.url }, { warn: () => {}, info: () => {} });
    await a.start();
    await b.start();
    const got: unknown[] = [];
    const off = b.subscribe(['bank'], (e) => got.push(e));
    await t.db.transaction().execute(async (trx) => {
      await publish(trx, { topic: 'bank', kind: 'question', id: 'qa-1' });
      await new Promise((r) => setTimeout(r, 150));
      expect(got).toEqual([]); // not before commit
    });
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ topic: 'bank', kind: 'question', id: 'qa-1' });
    // A rolled-back change sends nothing.
    await t.db
      .transaction()
      .execute(async (trx) => {
        await publish(trx, { topic: 'bank', kind: 'rolled-back' });
        throw new Error('rollback');
      })
      .catch(() => {});
    await publish(t.db, { topic: 'users', kind: 'other topic' });
    await publish(t.db, { topic: 'bank', kind: 'after' });
    await waitFor(() => got.length === 2);
    expect(got.map((e) => (e as { kind: string }).kind)).toEqual(['question', 'after']);
    off();
    expect(b.subscriptions).toBe(0);
    await a.stop();
    await b.stop();
  });

  it('HOST-5: events are hints, not data: a big payload is refused, so the 8000-byte limit is never hit', async () => {
    await expect(publish(t.db, { topic: 'bank', kind: 'x'.repeat(8000) })).rejects.toThrow(/too large/);
    await expect(publish(t.db, { topic: 'Bad Topic!', kind: 'x' })).rejects.toThrow(/Bad live topic/);
  });

  it('HOST-5: after the listening connection is lost, the bus reconnects and tells subscribers to refetch', async () => {
    const bus = new LiveBus({ connectionString: t.url }, { warn: () => {}, info: () => {} });
    await bus.start();
    const got: string[] = [];
    bus.subscribe(['bank'], (e) => got.push(e.kind));
    await t.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'interview-assistant-live' AND datname = current_database()`);
    await waitFor(() => got.includes('resync'), 10_000);
    await publish(t.db, { topic: 'bank', kind: 'after-reconnect' });
    await waitFor(() => got.includes('after-reconnect'));
    await bus.stop();
  });
});

describe('Server-Sent Events across two app instances', () => {
  let one: TestApp;
  let two: TestApp;
  beforeAll(async () => {
    one = await startApp(t);
    two = await startApp(t, { build: { liveHeartbeatMs: 200 } });
    await one.app.listen({ port: 0, host: '127.0.0.1' });
    await two.app.listen({ port: 0, host: '127.0.0.1' });
    await addUser(t.db, 'admin@example.test', 'admin');
    await addUser(t.db, 'watcher@example.test', 'admin');
  });
  afterAll(async () => {
    await one.close();
    await two.close();
  });

  /** Opens a stream on `app` and collects its events until `until` holds. */
  async function stream(app: TestApp, cookie: string, topics: string[]) {
    const port = (app.app.server.address() as { port: number }).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/live?${topics.map((x) => `topic=${x}`).join('&')}`, { headers: { cookie }, signal: ctrl.signal });
    const events: Array<{ event: string; data: unknown }> = [];
    let ended = false;
    const reader = res.body!.getReader();
    void (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        /* aborted */
      }
      ended = true;
    })();
    return { res, events, ended: () => ended, close: () => ctrl.abort() };
  }

  it('HOST-5 USER-4: a change made through instance one reaches a browser connected to instance two', async () => {
    const cookie = await signIn(one.app, 'admin@example.test');
    const s = await stream(two, cookie, ['users']);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await waitFor(() => s.events.some((e) => e.event === 'ready'));
    await client(one.app, cookie).post('/api/users', { text: 'new@example.test', role: 'interviewer' });
    await waitFor(() => s.events.some((e) => e.event === 'change'));
    expect(s.events.find((e) => e.event === 'change')!.data).toEqual({ topic: 'users', kind: 'added' });
    s.close();
  });

  it('HOST-5 AUTH-5: a stream needs a session, and only topics the person may read', async () => {
    const port = (two.app.server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/api/live?topic=bank`)).status).toBe(401);
    await addUser(t.db, 'int@example.test', 'interviewer');
    const cookie = await signIn(one.app, 'int@example.test');
    expect((await fetch(`http://127.0.0.1:${port}/api/live?topic=users`, { headers: { cookie } })).status).toBe(400);
    const ok = await stream(two, cookie, ['bank']);
    expect(ok.res.status).toBe(200);
    ok.close();
  });

  it('HOST-5 USER-3: deactivating someone closes their open stream at once', async () => {
    const target = await addUser(t.db, 'stream-gone@example.test', 'admin');
    const cookie = await signIn(one.app, 'stream-gone@example.test');
    const s = await stream(two, cookie, ['bank']);
    await waitFor(() => s.events.some((e) => e.event === 'ready'));
    const adminCookie = await signIn(one.app, 'watcher@example.test');
    await client(one.app, adminCookie).patch(`/api/users/${target}`, { active: false });
    await waitFor(() => s.events.some((e) => e.event === 'revoked'));
    await waitFor(() => s.ended());
  });

  it('HOST-5 AUTH-4: a stream whose session ends some other way is closed at the next heartbeat', async () => {
    await addUser(t.db, 'beat@example.test', 'interviewer');
    const cookie = await signIn(one.app, 'beat@example.test');
    const s = await stream(two, cookie, ['bank']);
    await waitFor(() => s.events.some((e) => e.event === 'ready'));
    await t.db.deleteFrom('auth_sessions').execute();
    await waitFor(() => s.ended(), 5000);
    expect(s.events.at(-1)!.event).toBe('revoked');
  });
});
