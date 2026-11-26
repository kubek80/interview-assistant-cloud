import { useMemo, useState } from 'react';
import { RepoError, setAiEnabled } from '../../db';
import { docSection } from '../../docs/content';
import { renderDocHtml } from '../../docs/render';
import { AI_DESTINATION, AI_NOT_SENT } from '../../domain/ai/request';
import { Alert, Badge, Button, Card, Checkbox, DocLink, HelpLink, Icon, formatDateTime, useToast } from '../../ui';
import { useAiAvailability } from '../transcript/useAi';

const NOTICE_SLUG = '11-interviewers-transcripts-ai';
const NOTICE_HEADING = 'Privacy notice for AI and transcripts';

/**
 * AI-1, AI-2: the AI second opinion is off until turned on here for this device. Turning it on shows
 * the privacy notice from the documentation and needs an explicit acknowledgement. The local
 * helper's status is checked only while it is on.
 */
export function AiAdmin() {
  const { settings, status, recheck } = useAiAvailability();
  const { toast } = useToast();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = useMemo(() => {
    const md = docSection(NOTICE_SLUG, NOTICE_HEADING);
    return md ? renderDocHtml({ slug: NOTICE_SLUG, title: NOTICE_HEADING, markdown: md.replace(/^## /, '### ').replace(/ ?\(`[A-Z][A-Z0-9]*-\d+`\)/g, '') }) : '';
  }, []);

  const turn = async (on: boolean) => {
    if (on && !ack) {
      setError('Tick the box to confirm you have read the privacy notice.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setAiEnabled(on, { noticeAcknowledged: on ? ack : undefined });
      toast(on ? 'AI second opinion turned on for this device. Recorded in the audit log.' : 'AI second opinion turned off for this device.', 'success');
      setAck(false);
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'Could not change the setting.');
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <p className="muted" aria-busy="true">
        Loading…
      </p>
    );
  }

  return (
    <div className="stack-lg adm-ai">
      <Card level={3} title="AI second opinion on this device" actions={<DocLink req="AI-2" />}>
        <div className="stack">
          <p>
            An optional second opinion that scores the interview transcript with the same questions and rubric. It sits beside the interviewers’ scores and
            never changes them or the decision. It is shown only after the interview is submitted.{' '}
            <HelpLink slug={NOTICE_SLUG} section="ai-second-opinion">
              How it works
            </HelpLink>
          </p>
          <p className="adm-ai__state">
            {settings.enabled ? (
              <Badge tone="success" icon="check">
                On
              </Badge>
            ) : (
              <Badge tone="neutral" icon="circle">
                Off
              </Badge>
            )}{' '}
            {settings.enabled ? `Turned on ${formatDateTime(settings.acknowledgedAt)}, after the privacy notice was acknowledged.` : 'Off by default. Nothing is ever sent while it is off.'}
          </p>
        </div>
      </Card>

      <Card level={3} title="Privacy notice" actions={<DocLink req="PRIV-2" />}>
        <div className="stack">
          {/* Our own bundled Markdown, sanitised with DOMPurify in renderDocHtml (SEC-2). */}
          <div className="doc-content adm-ai__notice" dangerouslySetInnerHTML={{ __html: notice }} />
          <div className="adm-ai__sent">
            <p>
              <strong>Sent when a person runs it:</strong> the transcript with speaker names replaced, and each planned question with its description, key
              points, red flags, probes and rubric. <DocLink req="AI-5" />
            </p>
            <p>
              <strong>Never sent:</strong> {AI_NOT_SENT.join('; ')}.
            </p>
            <p>
              <strong>Where it goes:</strong> {AI_DESTINATION}
            </p>
          </div>
          {!settings.enabled ? (
            <div className="stack-sm">
              <Checkbox
                checked={ack}
                onChange={(e) => {
                  setAck(e.target.checked);
                  setError(null);
                }}
                label="I have read the privacy notice above. I will use the AI second opinion with real candidates only after Privacy/Legal and HR have approved it and the candidate has been told."
              />
              {error && (
                <p className="field__error" role="alert">
                  <Icon name="alert" />
                  <span>{error}</span>
                </p>
              )}
              <div>
                <Button variant="primary" icon="check" onClick={() => void turn(true)} disabled={busy}>
                  Turn on the AI second opinion
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button icon="x" onClick={() => void turn(false)} disabled={busy}>
                Turn off the AI second opinion
              </Button>
            </div>
          )}
        </div>
      </Card>

      {settings.enabled && (
        <Card level={3} title="Local helper" actions={<DocLink req="AI-1" />}>
          <div className="stack">
            {!status ? (
              <p className="muted" role="status">
                Checking the local helper…
              </p>
            ) : status.state === 'ready' ? (
              <Alert tone="success" role="status" title="Ready.">
                <p>
                  Claude Code {status.cliVersion ?? '(version unknown)'} is signed in on this computer. Model: {status.model ?? 'Claude Code’s default'}.
                  {status.busy ? ' A run is in progress.' : ''}
                </p>
              </Alert>
            ) : (
              <Alert tone="warning" role="status" title="Unavailable.">
                <p>{status.message}</p>
                <p className="small">
                  The AI second opinion needs the local helper: on this computer, run <code>npm start</code> in the app’s folder and open the address it
                  prints (for example <code>http://localhost:4173/</code>). Everything else in the app works without it.
                </p>
              </Alert>
            )}
            <div>
              <Button size="sm" variant="ghost" icon="undo" onClick={recheck}>
                Check again
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
