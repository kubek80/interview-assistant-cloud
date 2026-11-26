import { forwardRef, useEffect, useId, useState, type DragEvent, type Ref } from 'react';
import { RECORDING_WARN_BYTES, RepoError, attachRecording, isMediaType, removeRecording, type RecordingRecord } from '../../db';
import { Alert, Button, ConfirmDialog, DocLink, Icon, formatDateTime, useToast } from '../../ui';
import { formatBytes, mediaKind } from './model';
import { FilePick } from './FilePick';

/**
 * TR-2: a recording attached for playback. Stored on this device only; never sent anywhere and
 * never transcribed. The player uses an object URL of the stored file (CSP media-src blob:).
 */
export const RecordingPanel = forwardRef<HTMLMediaElement, { sessionId: string; recording: RecordingRecord | null; canAttach: boolean; readOnly?: boolean }>(function RecordingPanel(
  { sessionId, recording, canAttach, readOnly },
  ref,
) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(recording.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [recording]);

  const store = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const r = await attachRecording(sessionId, { blob: file, name: file.name, type: file.type, size: file.size });
      toast(r.replaced ? 'Recording replaced. It stays on this device.' : 'Recording attached. It stays on this device.', 'success');
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'The recording could not be stored.');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const choose = (file: File | undefined | null) => {
    setError(null);
    if (!file) return;
    if (!isMediaType(file.type)) {
      setError('Choose an audio or video file (for example .mp3, .m4a, .wav, .mp4 or .webm).');
      return;
    }
    // TR-2: warn before storing a file larger than 200 MB; also confirm a replacement.
    if (file.size > RECORDING_WARN_BYTES || recording) setPending(file);
    else void store(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canAttach && !busy) choose(e.dataTransfer.files?.[0]);
  };

  const kind = recording ? mediaKind(recording.type) : 'audio';
  const big = !!pending && pending.size > RECORDING_WARN_BYTES;

  return (
    <section className="tp-block" aria-labelledby={`${id}-h`}>
      <div className="tp-block__head">
        <h3 id={`${id}-h`} className="tp-block__title">
          <Icon name="play" /> Recording
        </h3>
        <DocLink req="TR-2" />
      </div>
      <p className="small tp-local">
        <Icon name="lock" /> A recording stays on this device for playback only. It is never sent anywhere, not even with the AI second opinion,
        and it is not transcribed.
      </p>
      {recording ? (
        <div className="stack-sm">
          <p className="small">
            <strong className="tp-filename">{recording.name}</strong> · {formatBytes(recording.size)} · {recording.type} · attached {formatDateTime(recording.attachedAt)}
          </p>
          {url &&
            (kind === 'video' ? (
              <video ref={ref as Ref<HTMLVideoElement>} className="tp-player tp-player--video" src={url} controls preload="metadata" aria-label="Interview recording" />
            ) : (
              <audio ref={ref as Ref<HTMLAudioElement>} className="tp-player" src={url} controls preload="metadata" aria-label="Interview recording" />
            ))}
          {!readOnly && (
            <div className="cluster">
              <FilePick label="Replace recording…" inputLabel="Recording file" accept="audio/*,video/*" disabled={!canAttach || busy} onFile={choose} />
              <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmRemove(true)} disabled={busy}>
                Remove recording…
              </Button>
            </div>
          )}
        </div>
      ) : readOnly ? (
        <p className="muted small">No recording attached.</p>
      ) : (
        <div
          className={`tp-drop${dragging ? ' tp-drop--over' : ''}${!canAttach ? ' tp-drop--disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (canAttach) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="small">Drop an audio or video file here, or</p>
          <FilePick label="Choose a recording…" inputLabel="Recording file" accept="audio/*,video/*" disabled={!canAttach || busy} onFile={choose} />
          <p className="small muted">The app asks before storing a file larger than {formatBytes(RECORDING_WARN_BYTES)}.</p>
        </div>
      )}
      {busy && (
        <p className="small" role="status">
          Storing the recording on this device…
        </p>
      )}
      {error && (
        <Alert tone="danger" role="alert" title="The recording was not attached.">
          <p>{error}</p>
        </Alert>
      )}
      <ConfirmDialog
        open={!!pending}
        title={big ? 'Store a large recording?' : 'Replace the recording?'}
        confirmLabel={big ? `Store ${pending ? formatBytes(pending.size) : ''}` : 'Replace recording'}
        onConfirm={() => (pending ? store(pending) : undefined)}
        onCancel={() => setPending(null)}
      >
        {big && (
          <p>
            This file is {pending ? formatBytes(pending.size) : ''}, more than {formatBytes(RECORDING_WARN_BYTES)}. It will be stored in this browser on this device
            and uses that much space until the interview is deleted. If the device runs out of space, nothing is stored.
          </p>
        )}
        {recording && <p>The recording attached now ({formatBytes(recording.size)}) will be replaced. The change is recorded in the audit log.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the recording?"
        confirmLabel="Remove recording"
        danger
        onConfirm={async () => {
          try {
            await removeRecording(sessionId);
            toast('Recording removed from this device.', 'success');
          } catch (e) {
            toast(e instanceof RepoError ? e.message : 'The recording could not be removed.', 'error');
          } finally {
            setConfirmRemove(false);
          }
        }}
        onCancel={() => setConfirmRemove(false)}
      >
        <p>The recording is deleted from this device. The removal is recorded in the audit log.</p>
      </ConfirmDialog>
    </section>
  );
});
