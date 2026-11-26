// AI-1, AI-2: whether the AI second opinion is on for this device and whether the local helper is
// ready. The helper is probed only when the feature is on (and quietly: see probeAiStatus), so a
// device that never uses the AI makes no request for it at all (OV-1, PRIV-2).
import { useCallback, useEffect, useState } from 'react';
import { probeAiStatus, type AiStatus } from '../../ai/client';
import { useAiSettings } from '../../db';
import { useOnline } from '../../ui';

export function useAiAvailability() {
  const settings = useAiSettings();
  const online = useOnline();
  const enabled = settings?.enabled === true;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    const ctrl = new AbortController();
    setStatus(null);
    probeAiStatus({ signal: ctrl.signal, skipMarker: import.meta.env.DEV })
      .then((s) => {
        if (!ctrl.signal.aborted) setStatus(s);
      })
      .catch(() => {
        /* aborted */
      });
    return () => ctrl.abort();
  }, [enabled, online, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { settings, status, recheck };
}
