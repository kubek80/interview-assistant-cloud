// Interviewing together over the API (LIVE-1…LIVE-8, RES-1…RES-3, HOST-5, HOST-6).
//
// Query keys start with the interview's live topic, so its events refetch exactly what changed
// (src/db/live.tsx): ['interview:<id>', 'state'] the shared state, ['interview:<id>', 'records'] my
// record and the others' marks, ['interview:<id>', 'present'] the candidate window. Scorecards are
// ['record', <recordId>].
//
// My record's changes go through the outbox (src/db/outbox.ts): shown at once, sent in order,
// kept in the browser while offline. Shared commands (Next, Pause, the lead) are sent at once and
// never queued.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, request } from './http';
import { orNull, queryClient, throwIfFatal } from './queryClient';
import { useLiveTopics } from './live';
import { Outbox, type OutboxSnapshot } from './outbox';
import { applyRecordOps, clockOffset, HEARTBEAT_MS, type ClockSample } from '../domain/live';
import type { AmendInput, LiveCommand, LiveRecords, LiveState, PresentView, RecordDetail, RecordOp, ScorecardData } from '../shared/api';

const stateKey = (id: string) => [`interview:${id}`, 'state'] as const;
const recordsKey = (id: string) => [`interview:${id}`, 'records'] as const;

// ---------------------------------------------------------------------------------------------
// The server's clock (RES-2): timers show server time, corrected for this computer's clock.

const samples: ClockSample[] = [];
let offset = 0;
const clockListeners = new Set<() => void>();

function noteClock(serverNow: number | undefined, sentAt: number, receivedAt: number) {
  if (typeof serverNow !== 'number') return;
  samples.push({ serverNow, sentAt, receivedAt });
  if (samples.length > 10) samples.shift();
  const next = clockOffset(samples);
  if (next !== offset) {
    offset = next;
    clockListeners.forEach((l) => l());
  }
}

/** The server's time now (epoch ms), as best this browser knows it. */
export function serverNow(): number {
  return Date.now() + offset;
}

/** For tests and diagnostics: how far the server's clock is ahead of this one (ms). */
export function useClockOffset(): number {
  return useSyncExternalStore(
    (l) => {
      clockListeners.add(l);
      return () => clockListeners.delete(l);
    },
    () => offset,
  );
}

async function timed<T extends { serverNow?: number }>(fn: () => Promise<T>): Promise<T> {
  const sentAt = Date.now();
  const r = await fn();
  noteClock(r?.serverNow, sentAt, Date.now());
  return r;
}

// ---------------------------------------------------------------------------------------------
// Reading

/** LIVE-2: the shared state of the interview, kept live. */
export function useLiveState(id: string | undefined): LiveState | null | undefined {
  useLiveTopics(id ? `interview:${id}` : '');
  const q = useQuery({
    queryKey: stateKey(id ?? ''),
    queryFn: () => orNull(timed(() => api.get<LiveState>(`/api/interviews/${id}/live`))),
    enabled: !!id,
    staleTime: 0,
    // A safety net under the live events: presence fades and missed events are caught up.
    refetchInterval: 20_000,
    networkMode: 'always',
  });
  throwIfFatal(q);
  return q.data;
}

/** LIVE-1, LIVE-3: my record (with my unsent changes applied) and the others' marks as I may see them. */
export function useLiveRecords(id: string | undefined): LiveRecords | null | undefined {
  useLiveTopics(id ? `interview:${id}` : '');
  const q = useQuery({
    queryKey: recordsKey(id ?? ''),
    queryFn: () => orNull(timed(() => api.get<LiveRecords>(`/api/interviews/${id}/records`))),
    enabled: !!id,
    staleTime: 0,
    networkMode: 'always',
  });
  throwIfFatal(q);
  const box = useOutboxSnapshot();
  return useMemo(() => {
    const data = q.data;
    if (!data?.mine) return data;
    const pending = box.pending.filter((p) => p.recordId === data.mine!.id).map((p) => p.op);
    if (!pending.length) return data;
    return { ...data, mine: { ...data.mine, ...applyRecordOps(data.mine, pending) } };
  }, [q.data, box]);
}

/** FLOW-11, LIVE-7: what the candidate window shows. */
export function usePresentView(id: string | undefined): PresentView | null | undefined {
  useLiveTopics(id ? `interview:${id}` : '');
  const q = useQuery({ queryKey: [`interview:${id}`, 'present'], queryFn: () => orNull(api.get<PresentView>(`/api/interviews/${id}/present`)), enabled: !!id, staleTime: 0, refetchInterval: 30_000 });
  throwIfFatal(q);
  return q.data;
}

/** FLOW-24: one record's scorecard (visibility decided by the server, LIVE-3). */
export function useScorecard(recordId: string | undefined): ScorecardData | null | 'hidden' | undefined {
  const q = useQuery({
    queryKey: ['record', recordId],
    queryFn: () =>
      orNull(api.get<ScorecardData>(`/api/records/${recordId}`)).catch((err: unknown) => {
        // LIVE-3: the round hides other people's scores until mine is submitted.
        if (err instanceof ApiError && err.status === 403) return 'hidden' as const;
        throw err;
      }),
    enabled: !!recordId,
    staleTime: 0,
  });
  useLiveTopics(q.data && q.data !== 'hidden' ? `interview:${q.data.record.interviewId}` : '');
  throwIfFatal(q);
  return q.data;
}

// ---------------------------------------------------------------------------------------------
// My record: the outbox

let box: Outbox | null = null;
let boxUser: string | null = null;
const EMPTY: OutboxSnapshot = { state: 'saved', pending: [] };
const boxListeners = new Set<() => void>();
let dropListener: ((message: string) => void) | null = null;

function classify(err: unknown): 'retry' | 'drop' {
  if (!(err instanceof ApiError)) return 'retry';
  return err.code === 'network' || err.status >= 500 || err.status === 429 || err.status === 401 ? 'retry' : 'drop';
}

/** The outbox of the signed-in person (one per person; created when they first change a record). */
export function outboxFor(userId: string): Outbox {
  if (box && boxUser === userId) return box;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  box = new Outbox({
    storage,
    key: `ia.outbox.v1.${userId}`,
    send: (recordId, ops) => api.post<RecordDetail>(`/api/records/${recordId}/ops`, { ops }),
    classify,
    onSent: (_recordId, result) => {
      const r = result as RecordDetail;
      queryClient.setQueryData<LiveRecords | null>(recordsKey(r.interviewId), (old) => (old ? { ...old, mine: r } : old));
    },
    onDropped: (_recordId, err) => {
      void queryClient.invalidateQueries({ queryKey: ['record'] });
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('interview:') });
      dropListener?.(err instanceof ApiError ? `A change was not saved: ${err.message}` : 'A change was not saved.');
    },
  });
  boxUser = userId;
  box.subscribe(() => boxListeners.forEach((l) => l()));
  boxListeners.forEach((l) => l());
  if (typeof window !== 'undefined') window.addEventListener('online', () => box?.flush());
  box.flush();
  return box;
}

/** HOST-6: try sending what is waiting now (the live connection is back). */
export function retrySaving(): void {
  box?.flush();
}

/** RES-3: what the outbox is doing (saved, saving, offline with N changes waiting). */
export function useOutboxSnapshot(): OutboxSnapshot {
  return useSyncExternalStore(
    (l) => {
      boxListeners.add(l);
      return () => boxListeners.delete(l);
    },
    () => box?.getSnapshot() ?? EMPTY,
  );
}

/** Starts my outbox as soon as I am signed in, so changes left from an earlier visit are sent. */
export function useOutbox(userId: string | undefined, onDropped?: (message: string) => void): OutboxSnapshot {
  useEffect(() => {
    if (userId) outboxFor(userId);
  }, [userId]);
  useEffect(() => {
    dropListener = onDropped ?? null;
    return () => {
      if (dropListener === onDropped) dropListener = null;
    };
  }, [onDropped]);
  return useOutboxSnapshot();
}

/** LIVE-1, RES-1: a change to my record: shown at once, saved as soon as the server can be reached. */
export function changeRecord(userId: string, recordId: string, ops: RecordOp[]): void {
  outboxFor(userId).add(recordId, ops);
}

// ---------------------------------------------------------------------------------------------
// Shared commands (LIVE-2): never queued

function setState(id: string, s: LiveState) {
  queryClient.setQueryData<LiveState | null>(stateKey(id), (old) => (old && old.version > s.version ? old : s));
}

/** FLOW-10, LIVE-6: confirm consent and start (or join, if someone has just started it). */
export async function startInterview(id: string, scoringWith: string[] = []): Promise<{ alreadyStarted: boolean }> {
  const sentAt = Date.now();
  const r = await api.post<{ alreadyStarted: boolean; state: LiveState }>(`/api/interviews/${id}/start`, { consent: true, ...(scoringWith.length ? { scoringWith } : {}) });
  noteClock(r.state.serverNow, sentAt, Date.now());
  setState(id, r.state);
  void queryClient.invalidateQueries({ queryKey: ['round'] });
  void queryClient.invalidateQueries({ queryKey: recordsKey(id) });
  return { alreadyStarted: r.alreadyStarted };
}

/** LIVE-8: join a running interview (again is harmless). */
export async function joinInterview(id: string, scoringWith: string[] = []): Promise<string> {
  const r = await api.post<{ recordId: string; state: LiveState }>(`/api/interviews/${id}/join`, scoringWith.length ? { scoringWith } : {});
  setState(id, r.state);
  await queryClient.invalidateQueries({ queryKey: recordsKey(id) });
  void queryClient.invalidateQueries({ queryKey: ['round'] });
  return r.recordId;
}

/**
 * LIVE-2: the lead moves everyone, pauses and resumes; anyone takes the lead. The screen shows the
 * move at once; if the server refuses it (someone else leads now, the panel already moved), the
 * shared state is fetched again and the error says why.
 */
export async function sendCommand(id: string, cmd: LiveCommand): Promise<LiveState> {
  const key = stateKey(id);
  const before = queryClient.getQueryData<LiveState | null>(key);
  if (before && cmd.type === 'move') queryClient.setQueryData<LiveState>(key, { ...before, currentQuestionId: cmd.to });
  try {
    const sentAt = Date.now();
    const s = await request<LiveState>('POST', `/api/interviews/${id}/command`, cmd);
    noteClock(s.serverNow, sentAt, Date.now());
    setState(id, s);
    return s;
  } catch (err) {
    if (before) queryClient.setQueryData(key, before);
    void queryClient.invalidateQueries({ queryKey: key });
    throw err;
  }
}

/** LIVE-4: an organiser marks a panel member as "did not take part" (or takes it back). */
export async function markDidNotTakePart(id: string, userId: string, didNotTakePart: boolean): Promise<void> {
  const s = await api.put<LiveState>(`/api/interviews/${id}/panel/${userId}`, { didNotTakePart });
  setState(id, s);
  void queryClient.invalidateQueries({ queryKey: ['round'] });
}

/**
 * LIVE-3: tells the server this screen is open (every HEARTBEAT_MS while visible) and that it has
 * closed. Presence is stored in the database, so every server instance sees it (HOST-5).
 */
export function usePresence(id: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!id || !enabled) return;
    const beat = () => {
      if (document.visibilityState === 'visible') void api.post(`/api/interviews/${id}/presence`, { here: true }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    const leave = () => {
      // keepalive lets the request finish while the page unloads.
      void fetch(`/api/interviews/${id}/presence`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-ia-request': '1' }, body: JSON.stringify({ here: false }) }).catch(() => {});
    };
    const onVisible = () => document.visibilityState === 'visible' && beat();
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', onVisible);
      leave();
    };
  }, [id, enabled]);
}

// ---------------------------------------------------------------------------------------------
// Finishing and amending (FLOW-22, FLOW-23, AUD-4)

/** FLOW-22, LIVE-4: sends anything still waiting, then submits my record. Needs a connection. */
export async function submitRecord(userId: string, recordId: string): Promise<ScorecardData> {
  const b = outboxFor(userId);
  if (b.isOffline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    throw new ApiError(0, 'network', 'You are offline. Your record is kept on this computer; submit it when the connection is back.');
  }
  await b.drained();
  const r = await api.post<ScorecardData>(`/api/records/${recordId}/submit`);
  queryClient.setQueryData(['record', recordId], r);
  await queryClient.invalidateQueries({ queryKey: [`interview:${r.record.interviewId}`] });
  void queryClient.invalidateQueries({ queryKey: ['round'] });
  return r;
}

/** AUD-4: amend my submitted record, with a reason. */
export async function amendRecord(recordId: string, input: AmendInput): Promise<RecordDetail> {
  const r = await api.post<RecordDetail>(`/api/records/${recordId}/amend`, input);
  await queryClient.invalidateQueries({ queryKey: ['record', recordId] });
  await queryClient.invalidateQueries({ queryKey: recordsKey(r.interviewId) });
  return r;
}

/** FLOW-32: an export of a scorecard is recorded before the file is given out. */
export async function recordExported(recordId: string, format: 'markdown' | 'csv' | 'print'): Promise<void> {
  await api.post(`/api/records/${recordId}/exported`, { format });
}
