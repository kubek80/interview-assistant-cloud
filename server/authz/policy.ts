// AUTH-5, USER-2, ROUND-2: the one place that answers "may this person do X (to this round)?".
// Every API route names the permission it needs (server/http/route.ts); a route without one cannot
// be registered. Deny by default: anything not granted below is refused.
import type { Role } from '../db/schema';

/** Who is asking: the signed-in, active user behind the request. */
export interface Actor {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

/**
 * What a role may touch at all, before any single permission. REVIEW-1: question reviewers have the
 * question bank and nothing else. Interview data (rounds, candidates, interviews, judgements,
 * decisions, summaries, transcripts, the audit log, settings) needs the `interviewData` capability,
 * which reviewers lack. A permission is a question-bank permission only if it is listed in
 * QUESTION_BANK_ACTIONS; every other permission, including any added later, needs interview data, and
 * every round permission does too (canInRound). So a new route is closed to reviewers by default.
 */
export type Capability = 'questionBank' | 'interviewData';
const CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: ['questionBank', 'interviewData'],
  organiser: ['questionBank', 'interviewData'],
  interviewer: ['questionBank', 'interviewData'],
  reviewer: ['questionBank'],
};

export function hasCapability(actor: Actor | null, c: Capability): boolean {
  return !!actor && (CAPABILITIES[actor.role]?.includes(c) ?? false);
}

/** Permissions that are about the question bank only (no interview data behind them). */
export const QUESTION_BANK_ACTIONS: ReadonlySet<string> = new Set(['bank.read', 'bank.edit', 'bank.import', 'bank.propose', 'bank.comment', 'bank.review', 'reviews.respond']);

/** Permissions that do not depend on a round. */
export const GLOBAL_ACTIONS = [
  'bank.read',
  'bank.edit',
  'bank.import',
  'bank.propose',
  'bank.comment',
  'bank.review',
  'reviews.respond',
  'users.read',
  'users.manage',
  'audit.read',
  'audit.export',
  'settings.read',
  'settings.manage',
  'rounds.create',
  'rounds.list',
] as const;
export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];

/** USER-2 as a table: which role has which permission. */
const GLOBAL: Record<GlobalAction, readonly Role[]> = {
  'bank.read': ['admin', 'organiser', 'interviewer', 'reviewer'],
  // REVIEW-2, REVIEW-3, REVIEW-4: reviewers propose changes and new questions and mark "looks good".
  'bank.propose': ['reviewer'],
  // REVIEW-4: comments are written and read by reviewers, organisers and administrators.
  'bank.comment': ['admin', 'organiser', 'reviewer'],
  // REVIEW-5, REVIEW-7: deciding proposals and asking for reviews.
  'bank.review': ['admin', 'organiser'],
  // REVIEW-7: a reviewer's own list of review requests.
  'reviews.respond': ['reviewer'],
  'bank.edit': ['admin', 'organiser'],
  // DB-3: uploading track or CSV files with the import report is for administrators.
  'bank.import': ['admin'],
  'users.read': ['admin'],
  'users.manage': ['admin'],
  // HPRIV-4: the whole log for administrators; organisers see their rounds' entries (round.audit).
  'audit.read': ['admin'],
  'audit.export': ['admin'],
  'settings.read': ['admin', 'organiser', 'interviewer'],
  'settings.manage': ['admin'],
  // ROUND-1 (step 2): organisers and administrators create rounds.
  'rounds.create': ['admin', 'organiser'],
  // ROUND-2 (step 2): everyone may list rounds; the list itself is filtered to the rounds they are on.
  'rounds.list': ['admin', 'organiser', 'interviewer'],
};

export function can(actor: Actor | null, action: GlobalAction): boolean {
  if (!actor) return false;
  if (!QUESTION_BANK_ACTIONS.has(action) && !hasCapability(actor, 'interviewData')) return false;
  return GLOBAL[action]?.includes(actor.role) ?? false;
}

/** Permissions on one round and everything inside it (step 2 builds the routes that use these). */
export const ROUND_ACTIONS = [
  'round.read', // see the round, its candidates, interviews, judgements, decisions and summary
  'round.manage', // change the round: name, team, settings, close and reopen
  'round.plan', // plan, change and cancel interviews; question sets
  'round.decide', // record and change panel decisions; enter judgements on someone's behalf
  'round.audit', // read the round's audit entries
  'round.export', // export the round's reports
  'interview.take_part', // join an interview on its panel and keep one's own record
  'record.amend', // AUD-4: change one's own submitted record, with a reason (the route checks ownership)
] as const;
export type RoundAction = (typeof ROUND_ACTIONS)[number];

/** What the policy needs to know about the round and the actor's place in it. */
export interface RoundAccess {
  roundId: string;
  /** The actor's role in this round's team, or null when they are not on it. */
  memberRole: 'organiser' | 'interviewer' | null;
  state: 'open' | 'closed';
}

/** Changes a closed round allows (ROUND-5): reading, and a few things for organisers with a reason. */
const ALLOWED_WHEN_CLOSED: ReadonlySet<RoundAction> = new Set(['round.read', 'round.audit', 'round.export', 'round.manage', 'round.decide', 'record.amend']);

/**
 * ROUND-2: people see only the rounds they are on; administrators see every round. Within a round,
 * organisers of that round run it and interviewers take part. ROUND-5: a closed round is read-only,
 * except that its organisers and administrators may reopen it or correct decisions (with a reason,
 * which the route enforces).
 */
export function canInRound(actor: Actor | null, action: RoundAction, round: RoundAccess | null): boolean {
  if (!actor || !round) return false;
  // REVIEW-1: nothing inside a round, ever, without interview data, whatever the membership says.
  if (!hasCapability(actor, 'interviewData')) return false;
  if (round.state === 'closed' && !ALLOWED_WHEN_CLOSED.has(action)) return false;
  if (actor.role === 'admin') return true;
  const member = round.memberRole;
  if (!member) return false;
  switch (action) {
    case 'round.read':
    case 'round.export':
      return true;
    case 'interview.take_part':
      return true; // the route also checks that the actor is on that interview's panel
    case 'record.amend':
      // AUD-4: the owner amends their own record (the route checks ownership). ROUND-5: in a closed
      // round only its organisers (and administrators) may still correct their judgements.
      return round.state === 'open' || member === 'organiser';
    case 'round.manage':
    case 'round.plan':
    case 'round.decide':
    case 'round.audit':
      // A round organiser who is an "interviewer" in the global sense still runs their round;
      // a global organiser who is only an interviewer in this round does not.
      return member === 'organiser';
  }
  return false;
}

/** The global permissions an actor holds, sent to the browser so it can show the right screens. */
export function permissionsOf(actor: Actor): GlobalAction[] {
  return GLOBAL_ACTIONS.filter((a) => can(actor, a));
}
