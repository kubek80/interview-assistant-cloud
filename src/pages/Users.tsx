import { useEffect, useId, useMemo, useState } from 'react';
import { addUsers, previewInvites, removeUser, updateUser, useUsers } from '../db';
import { ROLES, ROLE_LABELS, type InvitePreviewLine, type Me, type Role, type UserSummary } from '../shared/api';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, MenuButton, PageHeader, Select, TextArea, TextInput, formatDateTime, useDocumentTitle, useToast } from '../ui';
import '../styles/pages/bank.css';
import '../styles/pages/users.css';

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

/** Route: /users, for administrators (USER-1…USER-4). Every change is checked and audited on the server. */
export default function Users({ me }: { me: Me }) {
  useDocumentTitle('Users');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { users, hasMore, loadMore, loadingMore } = useUsers(query);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'deactivate' | 'remove' | 'demote-self'; user: UserSummary; role?: Role } | null>(null);
  const { toast } = useToast();

  // Search on the server as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const counts = useMemo(() => (users ? { total: users.length, inactive: users.filter((u) => !u.active).length } : null), [users]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work. Try again.', 'error');
    }
  };

  const changeRole = (u: UserSummary, role: Role) => {
    if (u.id === me.id && role !== 'admin' && u.role === 'admin') setConfirm({ kind: 'demote-self', user: u, role });
    else void run(() => updateUser(u.id, { role }), `${label(u)} is now ${ROLE_LABELS[role].toLowerCase()}.`);
  };

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who can sign in, and what they can do."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add people
          </Button>
        }
      />
      <div className="users-toolbar">
        <Field label="Find a person" hideLabel>
          <TextInput type="search" placeholder="Find by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        {counts && (
          <p className="small muted" role="status" aria-live="polite">
            {counts.total} {counts.total === 1 ? 'person' : 'people'}
            {query ? ' found' : ''}
            {counts.inactive ? ` · ${counts.inactive} deactivated` : ''}
          </p>
        )}
      </div>
      {users === undefined ? (
        <p className="muted">Loading…</p>
      ) : users.length === 0 ? (
        <EmptyState title="Nobody matches that search." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table users-table pc-rtable">
              <caption className="visually-hidden">People with access</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Last signed in</th>
                  <th scope="col">Rounds</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isMe={u.id === me.id}
                    onRole={(r) => changeRole(u, r)}
                    onDeactivate={() => setConfirm({ kind: 'deactivate', user: u })}
                    onReactivate={() => void run(() => updateUser(u.id, { active: true }), `${label(u)} can sign in again.`)}
                    onRemove={() => setConfirm({ kind: 'remove', user: u })}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <p>
              <Button onClick={loadMore} disabled={loadingMore}>
                Show more
              </Button>
            </p>
          )}
          {counts?.total === 1 && !query && <p className="muted users-hint">Add the people who will organise and take part in interviews.</p>}
        </>
      )}
      <AddPeopleDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={confirm?.kind === 'deactivate'}
        danger
        title={`Deactivate ${confirm ? label(confirm.user) : ''}?`}
        confirmLabel="Deactivate"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const u = confirm!.user;
          setConfirm(null);
          await run(() => updateUser(u.id, { active: false }), `${label(u)} is deactivated and signed out.`);
        }}
      >
        <p>They are signed out straight away and cannot sign in until they are reactivated. What they recorded stays, under their name.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'remove'}
        danger
        title={`Remove ${confirm ? label(confirm.user) : ''}?`}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const u = confirm!.user;
          setConfirm(null);
          await run(() => removeUser(u.id), `${label(u)} is removed.`);
        }}
      >
        <p>They have never signed in. You can add them again later.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'demote-self'}
        danger
        title="Change your own role?"
        confirmLabel="Change my role"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const { user: u, role } = confirm!;
          setConfirm(null);
          await run(() => updateUser(u.id, { role: role! }), `You are now ${ROLE_LABELS[role!].toLowerCase()}.`);
        }}
      >
        <p>You will no longer be an administrator, so you will lose access to this page.</p>
      </ConfirmDialog>
    </>
  );
}

const label = (u: Pick<UserSummary, 'name' | 'email'>) => u.name ?? u.email;

function UserRow(props: { user: UserSummary; isMe: boolean; onRole: (r: Role) => void; onDeactivate: () => void; onReactivate: () => void; onRemove: () => void }) {
  const { user: u, isMe } = props;
  const roleId = useId();
  const items = [
    u.active
      ? { label: 'Deactivate…', icon: 'eye-off' as const, onSelect: props.onDeactivate, disabled: isMe }
      : { label: 'Reactivate', icon: 'undo' as const, onSelect: props.onReactivate },
    ...(!u.lastSignInAt && !isMe ? [{ label: 'Remove…', icon: 'trash' as const, onSelect: props.onRemove }] : []),
  ];
  return (
    <tr className={u.active ? undefined : 'users-row--inactive'}>
      <td data-label="Name">
        <div className="users-name">
          <span className="users-name__main">
            {u.name ?? u.email}
            {isMe && <span className="small muted"> (you)</span>}
            {!u.active && (
              <>
                {' '}
                <Badge tone="warning" icon="eye-off">
                  Deactivated
                </Badge>
              </>
            )}
          </span>
          {u.name && <span className="users-name__email">{u.email}</span>}
        </div>
      </td>
      <td data-label="Role">
        <label htmlFor={roleId} className="visually-hidden">
          Role for {label(u)}
        </label>
        <Select id={roleId} className="users-role" value={u.role} options={ROLE_OPTIONS} onChange={(e) => props.onRole(e.target.value as Role)} disabled={!u.active} />
      </td>
      <td data-label="Last signed in" className="nowrap">
        {u.lastSignInAt ? <time dateTime={u.lastSignInAt}>{formatDateTime(u.lastSignInAt)}</time> : <span className="muted">Never</span>}
      </td>
      <td data-label="Rounds">{u.role === 'reviewer' ? <span className="muted">Not on rounds</span> : u.rounds.length ? u.rounds.map((r) => r.name).join(', ') : <span className="muted">None</span>}</td>
      <td className="pc-rtable__actions">
        <MenuButton label="More" variant="ghost" size="sm" srLabel={` for ${label(u)}`} items={items} />
      </td>
    </tr>
  );
}

/** USER-1: add one person or many by pasting email addresses, with a preview before anything is added. */
function AddPeopleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>('interviewer');
  const [preview, setPreview] = useState<InvitePreviewLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setText('');
      setPreview(null);
      setError(null);
      setRole('interviewer');
    }
  }

  useEffect(() => {
    if (!open || !text.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      previewInvites(text).then(
        (p) => live && (setPreview(p), setError(null)),
        (err: unknown) => live && setError(err instanceof Error ? err.message : 'Could not check the addresses.'),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, open]);

  const toAdd = preview?.filter((l) => l.outcome === 'add') ?? [];
  const groups: Array<{ key: InvitePreviewLine['outcome']; title: string; tone: 'success' | 'neutral' | 'warning' }> = [
    { key: 'add', title: 'Will be added', tone: 'success' },
    { key: 'exists', title: 'Already have access', tone: 'neutral' },
    { key: 'duplicate', title: 'Listed twice', tone: 'neutral' },
    { key: 'invalid', title: 'Not email addresses', tone: 'warning' },
  ];

  const submit = async () => {
    if (!toAdd.length) {
      setError(text.trim() ? 'There is nobody new to add.' : 'Enter at least one email address.');
      return;
    }
    setBusy(true);
    try {
      const r = await addUsers(text, role);
      toast(`Added ${r.added.length} ${r.added.length === 1 ? 'person' : 'people'} as ${ROLE_LABELS[role].toLowerCase()}. They can sign in with Google now.`, 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add people"
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Email addresses" hint="One or more. Paste a list: commas, spaces or new lines are fine." error={error}>
          <TextArea data-autofocus rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)} options={ROLE_OPTIONS} />
        </Field>
        <p className="small muted">{roleHelp(role)}</p>
        {preview && preview.length > 0 && (
          <div className="users-preview" aria-live="polite">
            {groups.map((g) => {
              const lines = preview.filter((l) => l.outcome === g.key);
              if (!lines.length) return null;
              return (
                <div key={g.key} className="users-preview__group">
                  <p className="users-preview__title">
                    <Badge tone={g.tone}>{lines.length}</Badge> {g.title}
                  </p>
                  <ul>
                    {lines.map((l, i) => (
                      <li key={`${l.input}-${i}`}>
                        {l.email ?? l.input}
                        {l.existing && <span className="muted"> · {ROLE_LABELS[l.existing.role]}{l.existing.active ? '' : ', deactivated'}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <div className="pc-dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !toAdd.length}>
            {toAdd.length > 1 ? `Add ${toAdd.length} people` : 'Add person'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function roleHelp(role: Role): string {
  switch (role) {
    case 'admin':
      return 'Administrators can do everything, including this page.';
    case 'organiser':
      return 'Organisers run hiring rounds and edit the question bank.';
    case 'interviewer':
      return 'Interviewers take part in the rounds they are on and read the question bank.';
    case 'reviewer':
      return 'Question reviewers read the question bank, comment and propose changes. They see no interview data.';
  }
}
