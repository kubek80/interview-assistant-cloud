import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useBankStatus, useTrackBank, useTracks } from '../../db';
import type { Track } from '../../domain/types';
import { Button, DocLink } from '../../ui';
import { ExportTrackDialog, ImportTrackFile, PendingSeedAlert, UnexportedBadge } from '../bank/TrackFiles';
import { bankCounts } from './model';

/** BANK-6, BANK-7, BANK-14: loaded versions, counts and unexported changes per track; import and export track files. */
export function BankAdmin() {
  const tracks = useTracks();
  const status = useBankStatus();
  const [exportId, setExportId] = useState<string | null>(null);
  const importId = useId();
  return (
    <div className="stack-lg">
      <p>
        The bank is loaded from the bundled seed files, and reloaded when a seed’s version is newer than the one stored, unless the track has been changed on
        this device and the changes have not been exported. Questions are edited on the <Link to="/bank">Question bank</Link> screen. Locked plans keep their
        own copy of each question, so changing the bank never changes an existing interview. <DocLink req="BANK-6" /> <DocLink req="BANK-14" />{' '}
        <DocLink req="FLOW-8" />
      </p>
      {status?.pending.map((u) => <PendingSeedAlert key={u.trackId} update={u} onExport={setExportId} />)}
      <div className="table-wrap">
        <table className="table">
          <caption>Tracks on this device</caption>
          <thead>
            <tr>
              <th scope="col">Track</th>
              <th scope="col">Version</th>
              <th scope="col" className="num">
                Questions
              </th>
              <th scope="col" className="num">
                Active
              </th>
              <th scope="col" className="num">
                Retired
              </th>
              <th scope="col" className="num">
                Categories
              </th>
              <th scope="col">Changes on this device</th>
              <th scope="col">Export</th>
            </tr>
          </thead>
          <tbody>
            {tracks === undefined ? (
              <tr>
                <td colSpan={8} className="muted">
                  Loading…
                </td>
              </tr>
            ) : tracks.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  No tracks are loaded.
                </td>
              </tr>
            ) : (
              tracks.map((t) => <TrackRow key={t.id} track={t} onExport={() => setExportId(t.id)} />)
            )}
          </tbody>
        </table>
      </div>
      <section className="stack" aria-labelledby={importId}>
        <h3 id={importId}>Import a track file</h3>
        <ImportTrackFile onExportFirst={setExportId} />
      </section>
      <ExportTrackDialog trackId={exportId} onClose={() => setExportId(null)} />
    </div>
  );
}

function TrackRow({ track, onExport }: { track: Track; onExport: () => void }) {
  const bank = useTrackBank(track.id);
  const counts = bank ? bankCounts(bank.questions) : null;
  return (
    <tr>
      <th scope="row">
        <Link to={`/bank/${track.id}`}>{track.name}</Link> <span className="muted small mono">{track.id}</span>
      </th>
      <td className="mono">{track.version}</td>
      <td className="num">{counts?.total ?? '…'}</td>
      <td className="num">{counts?.active ?? '…'}</td>
      <td className="num">{counts?.retired ?? '…'}</td>
      <td className="num">{bank?.categories.length ?? '…'}</td>
      <td>{bank?.changedAt ? <UnexportedBadge changedAt={bank.changedAt} /> : <span className="muted">None</span>}</td>
      <td>
        <Button size="sm" icon="download" onClick={onExport}>
          Export<span className="visually-hidden"> {track.name}</span>…
        </Button>
      </td>
    </tr>
  );
}
