import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_RETENTION_DAYS, addDays, defaultRetentionDate, isoDate } from '../../domain/plan';
import { validateCandidateInput, type CandidateInput } from '../../domain/validation';
import { toCandidateInput, type CandidateDraft, type CandidateErrors } from './candidateDraft';

/**
 * State for the FLOW-7 candidate form. Errors show for a field once it has been left, and for
 * every field after the first submit attempt, so a new form is not covered in red.
 */
export function useCandidateForm(
  initial: () => CandidateDraft,
  defaultInterviewer: string | null | undefined,
  onChange?: (d: CandidateDraft) => void,
  /** This device's default retention period (FLOW-7); applied once loaded if the date is still the built-in default. */
  defaultRetentionDays?: number,
  /** TR-4: this device's last "recorded or transcribed" choice; applied once loaded unless the draft has its own. */
  defaultRecordingNotice?: boolean,
) {
  const [value, setValue] = useState<CandidateDraft>(initial);
  const [touched, setTouched] = useState<ReadonlySet<keyof CandidateInput>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const filledName = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Prefill the interviewer name from this device's setting once it has loaded.
  useEffect(() => {
    if (filledName.current || defaultInterviewer === undefined) return;
    filledName.current = true;
    if (defaultInterviewer && !value.interviewerName.trim()) setValue((v) => ({ ...v, interviewerName: defaultInterviewer }));
  }, [defaultInterviewer, value.interviewerName]);

  // Apply the device's retention period once it has loaded, unless a date was already chosen.
  const filledRetention = useRef(false);
  useEffect(() => {
    if (filledRetention.current || defaultRetentionDays === undefined) return;
    filledRetention.current = true;
    if (defaultRetentionDays !== DEFAULT_RETENTION_DAYS && value.retentionUntil === defaultRetentionDate()) {
      setValue((v) => ({ ...v, retentionUntil: isoDate(addDays(new Date(), defaultRetentionDays)) }));
    }
  }, [defaultRetentionDays, value.retentionUntil]);

  const filledRecording = useRef(false);
  useEffect(() => {
    if (filledRecording.current || defaultRecordingNotice === undefined) return;
    filledRecording.current = true;
    if (value.recordingNotice === undefined) setValue((v) => ({ ...v, recordingNotice: defaultRecordingNotice }));
  }, [defaultRecordingNotice, value.recordingNotice]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onChangeRef.current?.(value);
  }, [value]);

  const allErrors: CandidateErrors = useMemo(() => validateCandidateInput(toCandidateInput(value), isoDate(new Date())), [value]);
  const errors: CandidateErrors = useMemo(() => {
    if (attempted) return allErrors;
    const out: CandidateErrors = {};
    for (const k of touched) if (allErrors[k]) out[k] = allErrors[k];
    return out;
  }, [allErrors, touched, attempted]);

  return {
    value,
    update: (patch: Partial<CandidateDraft>) => setValue((v) => ({ ...v, ...patch })),
    errors,
    allErrors,
    valid: Object.keys(allErrors).length === 0,
    touch: (f: keyof CandidateInput) => setTouched((t) => (t.has(f) ? t : new Set([...t, f]))),
    attempted,
    setAttempted,
    input: toCandidateInput(value),
  };
}
