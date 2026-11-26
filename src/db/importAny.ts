// TEAM-4, TEAM-5, FLOW-9: one import entry point for every kind of file the app exchanges between
// devices. The file's `kind` decides which importer validates and stores it (SEC-2).
import { RepoError } from './util';
import { importPlanFile, importSessionFile, type SessionImportResult } from './transfer';
import { importInvitationFile, type InvitationImportResult } from './planned';
import { importPanelFile, type PanelImportResult } from './panelFiles';
import { interviewersOf } from '../domain/interviewers';
import { formatCandidateKey } from '../domain/plan';
import type { Session } from '../domain/types';

export type ImportedFileResult =
  | { kind: 'invitation'; result: InvitationImportResult }
  | { kind: 'session'; result: SessionImportResult; interviewers: string[]; candidate: string }
  | { kind: 'plan'; planId: string; alreadyPresent: boolean; name: string }
  | { kind: 'panel'; result: PanelImportResult };

/** The kinds this entry point accepts, with the words used on screen. */
export const IMPORT_KINDS = { 'interview-invitation': 'invitation', 'interview-session': 'interview file', 'interview-plan': 'question set', 'interview-panel': 'panel file' } as const;

/** Reads the `kind` of an untrusted JSON value (or null). */
export function kindOf(json: unknown): string | null {
  return json && typeof json === 'object' && !Array.isArray(json) && typeof (json as { kind?: unknown }).kind === 'string' ? (json as { kind: string }).kind : null;
}

/** Routes one parsed file to its importer by `kind`. Throws RepoError for anything not accepted here. */
export async function importAnyFile(json: unknown): Promise<ImportedFileResult> {
  const kind = kindOf(json);
  switch (kind) {
    case 'interview-invitation':
      return { kind: 'invitation', result: await importInvitationFile(json) };
    case 'interview-session': {
      const result = await importSessionFile(json);
      const s = (json as { session: Session }).session;
      return { kind: 'session', result, interviewers: interviewersOf(s), candidate: formatCandidateKey(s.candidate) };
    }
    case 'interview-panel':
      return { kind: 'panel', result: await importPanelFile(json) };
    case 'interview-plan': {
      const r = await importPlanFile(json);
      return { kind: 'plan', ...r, name: String((json as { plan: { name: unknown } }).plan.name) };
    }
    default:
      throw new RepoError(
        'unknown-kind',
        kind === 'candidate-data'
          ? 'This is an access-request export; it cannot be imported.'
          : 'This is not an invitation, an interview file, a panel file or a question set from this app. Question bank files are imported on the Question bank screen.',
      );
  }
}
