#!/usr/bin/env node
// A deterministic stand-in for the Claude Code CLI, for tests and offline demos:
//   CLAUDE_BIN=server/test/fake-claude.mjs npm start
// It understands `--version`, `auth status` and `-p ... --json-schema <schema>` with the prompt on
// stdin, and answers with a result envelope shaped like the real CLI's (`--output-format json`).
// FAKE_CLAUDE_MODE selects the behaviour:
//   ok (default)   schema-valid result: questions scored 3, 2, 4, 1, ...; the last of 3+ not covered;
//                  each quotation is the start of a real "Candidate:" line from the transcript
//   invalid        structured output that does not match the expected shape
//   hang           never answers (to test the timeout)
//   slow           answers after FAKE_CLAUDE_DELAY_MS (default 1500)
//   not_signed_in  error envelope as when the sign-in is missing
//   rate_limited   error envelope for a usage limit
//   refusal        a refusal stop
//   garbage        non-JSON output and a non-zero exit code
//   leak           writes the whole prompt to stderr and argv to stdout noise before answering (the
//                  helper must not pass any of it on)
//   logged_out     `auth status` reports loggedIn: false
// FAKE_CLAUDE_ARGS_FILE, when set, receives {argv, cwd} as JSON for assertions.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';

if (argv[0] === '--version') {
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: mode !== 'logged_out', authMethod: 'fake' }, null, 2) + '\n');
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ argv, cwd: process.cwd() }));

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => main().catch(() => process.exit(3)));

const envelope = (extra) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  duration_ms: 12,
  num_turns: 2,
  stop_reason: 'tool_use',
  terminal_reason: 'completed',
  session_id: '00000000-0000-0000-0000-000000000000',
  total_cost_usd: 0,
  modelUsage: { 'fake-claude-model': { inputTokens: Math.round(input.length / 4), outputTokens: 321 }, 'fake-small-model': { inputTokens: 10, outputTokens: 5 } },
  ...extra,
});

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
}

async function main() {
  if (!argv.includes('-p')) process.exit(2);
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'slow') await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY_MS || 1500)));
  if (mode === 'garbage') {
    process.stdout.write('Something went wrong\n');
    process.exit(1);
  }
  if (mode === 'not_signed_in') emit(envelope({ is_error: true, api_error_status: 401, result: 'Not logged in · Please run /login', terminal_reason: 'api_error', modelUsage: {} }), 1);
  if (mode === 'rate_limited') emit(envelope({ is_error: true, api_error_status: 429, result: 'Claude usage limit reached.', terminal_reason: 'api_error' }), 1);
  if (mode === 'refusal') emit(envelope({ stop_reason: 'refusal', result: '', structured_output: undefined }));
  if (mode === 'leak') {
    process.stderr.write(input);
    process.stderr.write(argv.join(' '));
  }

  const schema = JSON.parse(arg('--json-schema') ?? '{}');
  const ids = schema?.properties?.questions?.items?.properties?.questionId?.enum ?? [];
  if (mode === 'invalid') emit(envelope({ structured_output: { questions: ids.map((id) => ({ questionId: id, score: 7 })) } }));

  const transcript = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(input)?.[1] ?? '';
  const candidateLines = transcript
    .split('\n')
    .map((l) => /^(?:\[[\d:]+\] )?Candidate: (.*)$/.exec(l)?.[1])
    .filter(Boolean);
  const SCORES = [3, 2, 4, 1];
  const questions = ids.map((id, i) => {
    const notCovered = ids.length >= 3 && i === ids.length - 1;
    if (notCovered) return { questionId: id, covered: false, score: null, keyPointsCovered: [], redFlagsObserved: [], rationale: 'The transcript has no answer to this question.', quotes: [] };
    const line = candidateLines[i % Math.max(1, candidateLines.length)];
    const quote = line ? line.split(/\s+/).slice(0, 8).join(' ') : null;
    return {
      questionId: id,
      covered: true,
      score: SCORES[i % SCORES.length],
      keyPointsCovered: [],
      redFlagsObserved: [],
      rationale: `Fake rationale for question ${i + 1}.`,
      quotes: quote ? [quote] : [],
    };
  });
  emit(envelope({ result: JSON.stringify({ questions }), structured_output: { questions } }));
}
