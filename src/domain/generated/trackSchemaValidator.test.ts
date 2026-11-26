import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import validate from './trackSchemaValidator';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('generated track schema validator', () => {
  it('BANK-3 BANK-7 SEC-2: is up to date with schema/track.schema.json (run `npm run gen:schema` after changing the schema)', () => {
    const fresh = execFileSync(process.execPath, ['scripts/gen-track-validator.mjs', '--print'], { cwd: ROOT, encoding: 'utf8' });
    expect(readFileSync(new URL('./trackSchemaValidator.js', import.meta.url), 'utf8')).toBe(fresh);
  });

  it('BANK-7: accepts a bundled seed file and rejects a broken one', () => {
    const seed = JSON.parse(readFileSync(new URL('../../../seed/qa.json', import.meta.url), 'utf8'));
    expect(validate(seed)).toBe(true);
    expect(validate({ ...seed, track: { id: 'QA!' } })).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });
});
