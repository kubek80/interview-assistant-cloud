import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { DocLink } from '../../docs/DocLink';
import { SHORTCUTS } from './logic';
import { ProgressLegend } from './ProgressList';

/** KEY-1: the "?" list. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      footer={
        <Button variant="primary" onClick={onClose} data-autofocus>
          Close
        </Button>
      }
    >
      <table className="table table--compact shortcuts-table">
        <caption className="visually-hidden">Shortcuts in the live interview</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.action}>
              <td className="nowrap">
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && ' '}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td>{s.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted shortcuts-note">
        Not while you type in a field, or with Ctrl, Alt or Cmd held. In the candidate view only <kbd>N</kbd>, <kbd>P</kbd>, <kbd>C</kbd> and <kbd>?</kbd> work, so
        nothing changes unseen while the candidate is looking. <DocLink req="KEY-1" />
      </p>
      <h3 className="shortcuts-legend__title">The question strip</h3>
      <ProgressLegend />
    </Dialog>
  );
}
