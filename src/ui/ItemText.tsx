import { leadLabel } from '../domain/leadLabel';

/**
 * BANK-15: a key point or red flag, with its leading label ("Mitigation first:") emphasised when
 * it has one, so a list of sentences can be scanned. The text is unchanged (label + rest) and is
 * rendered as React text (SEC-2).
 */
export function ItemText({ text }: { text: string }) {
  const parts = leadLabel(text);
  if (!parts) return <>{text}</>;
  return (
    <>
      <strong className="item-lead">{parts.lead}</strong>
      {parts.rest}
    </>
  );
}
