import '../../styles/pages/team.css';
import { Icon } from '../../ui';
import type { Attendance as AttendanceData } from '../../domain/team';

const names = (xs: readonly string[]) => xs.join(', ');

/**
 * TEAM-6: who is expected, who has submitted and who is still to come. `compact` is the one-line
 * form for Dashboard rows; the full form (debrief) lists the three groups. Colour is never the only
 * signal (A11Y-3): each group has a word and an icon.
 */
export function Attendance({ data, compact }: { data: AttendanceData; compact?: boolean }) {
  const submitted = data.submitted.map((s) => (s.you ? `${s.name} (here)` : s.name));
  if (compact) {
    // Until someone has submitted, the row's "with …" already says who is expected.
    if (!submitted.length) return null;
    return (
      <p className="attend attend--compact small" data-testid="attendance">
        {submitted.length > 0 && (
          <span className="attend__done">
            <Icon name="check" /> Submitted: {names(submitted)}
          </span>
        )}
        {data.toCome.length > 0 && (
          <span className="attend__todo">
            <Icon name="clock" /> Still to come: {names(data.toCome)}
          </span>
        )}
      </p>
    );
  }
  return (
    <dl className="attend attend--full" data-testid="attendance">
      <div>
        <dt>Expected</dt>
        <dd>{data.expected.length ? names(data.expected) : <span className="muted">Nobody named</span>}</dd>
      </div>
      <div>
        <dt>
          <Icon name="check" /> Submitted
        </dt>
        <dd>{submitted.length ? names(submitted) : <span className="muted">Nobody yet</span>}</dd>
      </div>
      <div>
        <dt>
          <Icon name="clock" /> Still to come
        </dt>
        <dd>{data.toCome.length ? names(data.toCome) : <span className="muted">Nobody</span>}</dd>
      </div>
    </dl>
  );
}
