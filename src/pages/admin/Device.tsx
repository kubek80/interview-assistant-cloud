import { useEffect, useState, type FormEvent } from 'react';
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RepoError,
  setDefaultRetentionDays,
  setIndependentScoring,
  setInterviewerName,
  useDefaultRetentionDays,
  useIndependentScoring,
  useInterviewerName,
} from '../../db';
import { Alert, Button, Card, Checkbox, DocLink, Field, HelpLink, TextInput, useToast } from '../../ui';

interface StorageInfo {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

function formatBytes(n: number | null): string {
  if (n == null) return 'unknown';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** AUD-1 actor name; storage limits of the pilot; what the pilot does not do. */
export function Device() {
  const stored = useInterviewerName();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (stored != null) setName(stored);
  }, [stored]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = navigator.storage;
      const est = s?.estimate ? await s.estimate().catch(() => null) : null;
      const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
      if (!cancelled) setStorage({ usage: est?.usage ?? null, quota: est?.quota ?? null, persisted });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await setInterviewerName(name);
      setSaved(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    }
  };

  return (
    <div className="stack-lg">
      <Card level={3} title="Interviewer name" actions={<DocLink req="AUD-1" />}>
        <form className="stack adm-name" onSubmit={save}>
          <Field label="Your name on this device" hint="Recorded as the actor in the audit log and offered when setting up an interview.">
            <TextInput
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              autoComplete="name"
            />
          </Field>
          <div className="cluster">
            <Button type="submit" variant="primary" disabled={stored === undefined || name.trim() === (stored ?? '')}>
              Save name
            </Button>
            <span role="status" className="small">
              {saved ? 'Saved.' : ''}
            </span>
          </div>
        </form>
      </Card>

      <RetentionSetting />

      <IndependentScoringSetting />

      <Card level={3} title="Storage on this device" actions={<HelpLink slug="06-data-privacy" section="limits-of-the-pilot">Limits of the pilot</HelpLink>}>
        <p>
          Everything is stored in this browser on this device (IndexedDB). Nothing is sent to a server. <DocLink req="OV-1" />{' '}
          <DocLink req="PRIV-2" />
        </p>
        {storage && (
          <p className="small">
            Using about {formatBytes(storage.usage)} of {formatBytes(storage.quota)} available to this site. Storage is{' '}
            {storage.persisted ? 'persistent' : 'not marked persistent, so the browser may clear it under storage pressure'}.
          </p>
        )}
        <Alert tone="warning" title="Pilot limits">
          <p>
            There is no central access control and no encryption beyond what the device provides, and retention is only enforced
            when the app is opened. Clearing the browser’s site data deletes everything. Use a managed, disk-encrypted device and
            export session files for the panel.
          </p>
        </Alert>
      </Card>

      <Card level={3} title="Not in this pilot" muted>
        <p>
          The pilot has no user roles or single sign-on, no server-side audit log, and no calibration analytics (for example,
          flagging interviewers whose averages differ from the panel’s). These are planned for later versions.{' '}
          <HelpLink slug="09-roadmap">Roadmap</HelpLink>
        </p>
      </Card>
    </div>
  );
}

/** FLOW-7, FLOW-33, PRIV-5: the default retention period used by quick start and as the Setup default. */
function RetentionSetting() {
  const stored = useDefaultRetentionDays();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (stored !== undefined) setText(String(stored));
  }, [stored]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(text.trim());
    if (!text.trim() || !Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
      setError(`Enter whole days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`);
      return;
    }
    try {
      await setDefaultRetentionDays(n);
      setSaved(true);
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'Could not save.');
    }
  };

  return (
    <Card level={3} title="How long records are kept" actions={<DocLink req="PRIV-5" />}>
      <form className="stack adm-name" onSubmit={save} noValidate>
        <Field
          label="Default retention period (days)"
          hint="New interviews are kept this many days, then deleted when the app next opens. Used by quick start and as the default on the set-up screen. HR sets the real period."
          error={error}
        >
          <TextInput
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={text}
            className="adm-days"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setSaved(false);
            }}
          />
        </Field>
        <div className="cluster">
          <Button type="submit" disabled={stored === undefined || text.trim() === String(stored)}>
            Save retention period
          </Button>
          <span role="status" className="small">
            {saved ? 'Saved.' : ''}
          </span>
        </div>
      </form>
    </Card>
  );
}

/** FLOW-27: independent scoring, off by default. Audited. */
function IndependentScoringSetting() {
  const stored = useIndependentScoring();
  const [local, setLocal] = useState<boolean | null>(null);
  const on = local ?? stored;
  const { toast } = useToast();
  return (
    <Card level={3} title="Other interviewers’ scores" actions={<DocLink req="FLOW-27" />}>
      <Checkbox
        id="adm-independent"
        checked={on === true}
        disabled={on === undefined}
        onChange={async (e) => {
          const next = e.target.checked;
          setLocal(next);
          try {
            await setIndependentScoring(next);
          } catch (err) {
            setLocal(null);
            toast(err instanceof Error ? err.message : 'Could not save.', 'error');
          }
        }}
        label="Hide other people’s scores until I have submitted mine"
        description="Off: imported interviews are shown at once. On: you see only who has submitted until your own interview of that candidate is submitted."
      />
    </Card>
  );
}
