/** Saves text as a file via a temporary object URL (no network, PRIV-2). */
export function downloadFile(name: string, mime: string, text: string): void {
  downloadBlob(name, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/** Saves a Blob (e.g. a stored recording, TR-3) as a file via a temporary object URL. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * Reads a user-chosen file as JSON. The result is untrusted (SEC-2): pass it to a validator
 * (validatePlanFile / validateSessionFile / validateTrackFile, or the db import functions).
 */
export async function readJsonFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('The file is too large to import.');
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('The file is not valid JSON.');
  }
}
