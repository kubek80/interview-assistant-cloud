import { useId } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTracks } from '../../db';
import { DocLink } from '../../ui';
import { ImportQuestions, UnexportedBadge } from '../bank/TrackFiles';

/** DB-3, DB-4, BANK-14: what is in the bank, and importing track and CSV files with a report first. */
export function BankFiles() {
  const tracks = useTracks();
  const navigate = useNavigate();
  const importId = useId();
  return (
    <div className="stack-lg">
      <div className="table-wrap">
        <table className="table">
          <caption>Tracks in the question bank</caption>
          <thead>
            <tr>
              <th scope="col">Track</th>
              <th scope="col">Version</th>
              <th scope="col" className="num">
                Active questions
              </th>
              <th scope="col" className="num">
                Retired
              </th>
              <th scope="col" className="num">
                Categories
              </th>
              <th scope="col">Exported</th>
            </tr>
          </thead>
          <tbody>
            {tracks === undefined ? (
              <tr>
                <td colSpan={6} className="muted">
                  Loading…
                </td>
              </tr>
            ) : tracks.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No questions yet. Import the track files below.
                </td>
              </tr>
            ) : (
              tracks.map((t) => (
                <tr key={t.id}>
                  <th scope="row">
                    <Link to={`/bank/${t.id}`}>{t.name}</Link> <span className="muted small mono">{t.id}</span>
                  </th>
                  <td className="mono">{t.version}</td>
                  <td className="num">{t.active}</td>
                  <td className="num">{t.questions - t.active}</td>
                  <td className="num">{t.categories}</td>
                  <td>{t.changedAt ? <UnexportedBadge changedAt={t.changedAt} /> : <span className="muted">Up to date</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <section className="stack" aria-labelledby={importId}>
        <h3 id={importId}>Import question files</h3>
        <p className="small muted">
          The same import as <span className="mono">npm run db:import-questions</span>. Questions already used in interviews keep their wording. <DocLink req="DB-2" />
        </p>
        <ImportQuestions onImported={(ids) => ids.length === 1 && navigate(`/bank/${ids[0]}`)} />
      </section>
    </div>
  );
}
