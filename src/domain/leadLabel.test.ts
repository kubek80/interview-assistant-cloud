import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leadLabel } from './leadLabel';
import type { TrackFile } from './types';

const lead = (s: string) => leadLabel(s)?.lead ?? null;

describe('BANK-15: the leading label of a key point or red flag', () => {
  it('BANK-15: "Short label: what you would hear" gives the label with its colon; lead + rest is the original text', () => {
    const s = 'Mitigation first: restored service before chasing root cause, for example by rolling back.';
    const r = leadLabel(s)!;
    expect(r.lead).toBe('Mitigation first:');
    expect(r.rest).toBe(' restored service before chasing root cause, for example by rolling back.');
    expect(r.lead + r.rest).toBe(s);
    expect(lead('Specificity and the cascade: keeps selectors flat.')).toBe('Specificity and the cascade:');
    expect(lead('CI/CD: runs on every push.')).toBe('CI/CD:');
    expect(lead('Comms: gave regular, plain updates.')).toBe('Comms:');
    expect(lead('Kind, specific wording: frames comments as questions.')).toBe('Kind, specific wording:');
    expect(lead('eBPF dataplane: Cilium handles packets inside the kernel.')).toBe('eBPF dataplane:');
    expect(lead('no-cache versus no-store: no-cache means store but revalidate.')).toBe('no-cache versus no-store:');
    expect(lead('Day-2 operations: upgrades and patching.')).toBe('Day-2 operations:');
    expect(lead('IDOR (insecure references): changes ids in URLs.')).toBe('IDOR (insecure references):');
    expect(lead('Candidate’s own actions: says “I” where it was their work.')).toBe('Candidate’s own actions:');
  });

  it('BANK-15: a full sentence with no colon, or a long sentence before the first colon, has no label', () => {
    expect(leadLabel('Describes a real review they gave or received and what changed.')).toBeNull();
    expect(leadLabel('Describes a real review they gave or received: what the change was.')).toBeNull(); // seven words
    expect(leadLabel('Treats retries as a signal, not a fix: a test that passes on retry is flaky.')).toBeNull(); // eight words
    expect(leadLabel('Supercalifragilisticexpialidocious and antidisestablishmentarianism: x y')).toBeNull(); // 48+ characters
    expect(leadLabel('')).toBeNull();
    expect(leadLabel(':')).toBeNull();
    expect(leadLabel(': starts with a colon')).toBeNull();
  });

  it('BANK-15: colons inside text are not labels: "e.g." lists, URLs, times, version numbers and code', () => {
    expect(leadLabel('Uses e.g.: Stylelint and visual tests.')).toBeNull();
    expect(leadLabel('Handles MFA and SSO (e.g. Entra ID): an MFA-free test tenant.')).toBeNull();
    expect(leadLabel('Names the escape hatches, e.g. javascript: links.')).toBeNull();
    expect(leadLabel('https://example.com/health returns 200 when ready.')).toBeNull();
    expect(leadLabel('Calls http://localhost:8080: the health endpoint.')).toBeNull();
    expect(leadLabel('Runs the job at 2:30 every night: the backup window.')).toBeNull();
    expect(leadLabel('Knows the OWASP Top 10:2025, with Broken Access Control at A01.')).toBeNull();
    expect(leadLabel('azure.workload.identity/use: "true" is set on the pod template.')).toBeNull();
    expect(leadLabel('Sets `azure.workload.identity/use: true` on the pod.')).toBeNull();
    expect(leadLabel('"JS is multithreaded": a false belief.')).toBeNull();
    expect(leadLabel("getByRole('button'): finds by role.")).toBeNull();
    expect(leadLabel('a = b: assignment')).toBeNull();
    expect(leadLabel('f(a,b): a call')).toBeNull();
    expect(leadLabel('Code splitting with dynamic import(): loads rarely used features.')).toBeNull();
    expect(leadLabel('Version 1.2: the old API.')).toBeNull();
    expect(leadLabel('LCP (Largest Contentful Paint), good at 2.5 s or less: improve by cutting server time.')).toBeNull();
  });

  it('BANK-15: a list introduction, unbalanced brackets or nothing after the colon is not a label', () => {
    expect(leadLabel('Tools such as: Flux and Argo CD.')).toBeNull();
    expect(leadLabel('Signals including: latency and errors.')).toBeNull();
    expect(leadLabel('Options (a: overlay')).toBeNull();
    expect(leadLabel('Phasing) and tooling: moved in stages.')).toBeNull();
    expect(leadLabel('Reflection:')).toBeNull();
    expect(leadLabel('Reflection: ')).toBeNull();
    expect(leadLabel('Reflection :  spaced colon')).toBeNull(); // space before the colon
    expect(leadLabel(' Reflection: leading space')).toBeNull();
  });

  it('BANK-15: across the bundled bank, every label rebuilds its item exactly and is short; long or code-like openings are left plain', () => {
    let items = 0;
    let labelled = 0;
    for (const id of ['web', 'qa', 'edge', 'aks']) {
      const file = JSON.parse(readFileSync(fileURLToPath(new URL(`../../seed/${id}.json`, import.meta.url)), 'utf8')) as TrackFile;
      for (const q of file.questions) {
        for (const s of [...q.lookFor, ...q.redFlags]) {
          items++;
          const r = leadLabel(s);
          if (!r) continue;
          labelled++;
          expect(r.lead + r.rest).toBe(s);
          expect(r.lead.split(/\s+/).length).toBeLessThanOrEqual(6);
          expect(r.lead).not.toMatch(/\./);
        }
      }
    }
    // Most bundled items are "label: what you would hear" or plain sentences; about a third have a label.
    expect(items).toBeGreaterThan(1800);
    expect(labelled).toBeGreaterThan(500);
    expect(labelled).toBeLessThan(items);
  });
});
