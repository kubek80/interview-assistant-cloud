import { useRef, useState } from 'react';
import { RepoError, exportPlanFile, importPlanFile } from '../../db';
import { Alert, Button, downloadFile, readJsonFile, useToast } from '../../ui';

/** FLOW-9: export a question set (locked plan) as a file (audited by the repository, FLOW-32). */
export function useExportPlan() {
  const { toast } = useToast();
  return async (planId: string) => {
    try {
      const f = await exportPlanFile(planId);
      downloadFile(f.fileName, f.mime, f.text);
      toast('Question set file saved. Share it with the other panelists.', 'success');
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'The question set could not be exported.', 'error');
    }
  };
}

/**
 * FLOW-9, SEC-2: "Import a question set" file button (`trigger`) and its error message (`errorAlert`). The file is validated by the repository before use;
 * problems are listed as text.
 */
export function useImportPlan(onImported?: (planId: string) => void, label = 'Import a question set file') {
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const { toast } = useToast();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const json = await readJsonFile(file);
      const r = await importPlanFile(json);
      toast(r.alreadyPresent ? 'These questions are already on this device.' : 'Question set imported.', 'success');
      onImported?.(r.planId);
    } catch (err) {
      setError(
        err instanceof RepoError
          ? { message: err.message, details: err.details }
          : { message: err instanceof Error ? err.message : 'The file could not be read.', details: [] },
      );
    } finally {
      if (input.current) input.current.value = '';
      button.current?.focus();
    }
  };

  const trigger = (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => onFile(e.target.files?.[0])}
        data-testid="import-plan-input"
      />
      <Button ref={button} icon="upload" variant="ghost" size="sm" onClick={() => input.current?.click()}>
        {label}
      </Button>
    </>
  );
  const errorAlert = error && (
    <Alert tone="danger" title={`Import failed: ${error.message}`} role="alert">
      {error.details.length > 0 && (
        <ul className="small">
          {error.details.slice(0, 10).map((d, i) => (
            <li key={i}>{d}</li>
          ))}
          {error.details.length > 10 && <li>…and {error.details.length - 10} more.</li>}
        </ul>
      )}
      <Button
        size="sm"
        onClick={() => {
          setError(null);
          button.current?.focus();
        }}
      >
        Dismiss
      </Button>
    </Alert>
  );
  return { trigger, errorAlert };
}
