// SUM-5: the round report (the Summary view as Markdown, CSV or a printable page). Audited.
import { db } from './db';
import { appendAudit, clock, getSetting, newId } from './util';
import { SETTINGS } from './db';
import { loadRound } from './decisions';
import { exportFileName, roundCsv, roundMarkdown, type RoundReportItem } from '../domain/export';
import { candidateDetail, roundRow } from '../domain/round';
import { computeScorecard, formatPct, BAND_LABELS } from '../domain/scoring';
import type { ExportedFile } from './transfer';

/**
 * SUM-5: the report for these panels, in this order (`refs` as the Summary screen lists them).
 * 'print' returns no file: call it just before window.print() so the PDF export is recorded too.
 */
export async function exportRoundReport(refs: readonly string[], format: 'markdown' | 'csv' | 'print', scope = ''): Promise<ExportedFile | null> {
  const all = await loadRound();
  const byRef = new Map(all.map((p) => [p.ref, p]));
  const panels = refs.map((r) => byRef.get(r)).filter((p): p is NonNullable<typeof p> => !!p);
  const items: RoundReportItem[] = panels.map((p) => {
    const ai = (p.record?.shared ?? [])
      .filter((s) => s.aiSecondOpinion)
      .map((s) => {
        const r = s.aiSecondOpinion!;
        const sc = computeScorecard(p.plan, p.plan.questions.flatMap((q) => {
          const x = r.questions.find((y) => y.questionId === q.id);
          return x ? [{ sessionId: 'ai', questionId: q.id, score: x.covered ? x.score : null, skipped: !x.covered, skipReason: null, coveredKeyPoints: [], redFlagsSeen: [], probeHandled: false, notes: [], flagged: false, elapsedSec: 0, timer: { accumulatedMs: 0, runningSince: null } }] : [];
        }));
        return { model: r.model, text: `On the transcript of ${s.interviewers.join(', ')}'s interview: ${formatPct(sc.overallPct)}, advisory band ${sc.insufficientEvidence ? 'insufficient evidence' : sc.band ? BAND_LABELS[sc.band] : '–'}. Not counted in the panel score.` };
      });
    return { row: roundRow(p), detail: candidateDetail(p), ai };
  });
  const exportedBy = (await getSetting<string>(SETTINGS.interviewerName))?.trim() || 'Unknown';
  await db.transaction('rw', [db.audit, db.settings], async () => {
    await appendAudit({ action: 'export', entity: 'panel', entityId: null, after: { format: `round-${format}`, candidates: items.length } });
  });
  const now = new Date(clock.now());
  if (format === 'print') return null;
  return format === 'markdown'
    ? { fileName: exportFileName('round-report', newId(), 'md', now), mime: 'text/markdown', text: roundMarkdown(items, { exportedBy, scope, now }) }
    : { fileName: exportFileName('round-report', newId(), 'csv', now), mime: 'text/csv', text: roundCsv(items.map((i) => i.row)) };
}
