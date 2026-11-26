import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, queryClient } from '../../db';
import type { OrgSettings } from '../../shared/api';
import { Button, Field, TextInput, useToast } from '../../ui';

/** Organisation settings: defaults for everyone (the hosted form of the local app's device settings). */
export function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<OrgSettings>('/api/settings') });
  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  if (!q.data) return <p className="muted">Loading…</p>;
  const value = days ?? String(q.data.defaultRetentionDays);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      setError('Enter whole days from 1 to 3650.');
      return;
    }
    setError(null);
    try {
      await api.patch('/api/settings', { defaultRetentionDays: n });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDays(null);
      toast('Saved. Recorded in the audit log.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    }
  };
  return (
    <form className="stack adm-settings" onSubmit={submit}>
      <Field label="Keep interview records for (days)" hint="The default for new hiring rounds. HR sets the real period." error={error}>
        <TextInput inputMode="numeric" value={value} onChange={(e) => setDays(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
