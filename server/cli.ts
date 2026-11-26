// Command-line tasks (HOST-4, DB-2, DB-3). In development: `npm run db:migrate`, `npm run db:seed`,
// `npm run db:import-questions -- <files…> [--dry-run] [--track <id>]`, `npm run db:dev-users`.
// In the container image (no dev tools): `node dist/server/cli.js migrate|seed|import-questions …`.
// Needs only DATABASE_URL (and DB_PASSWORD when the password is kept separately).
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ConfigError, loadDatabaseConfig } from './config';
import { createDb, createPool } from './db/pool';
import { migrate } from './db/migrate';
import { formatReport, importQuestions } from './bank/import';
import { appendAudit } from './audit/audit';
import type { ImportFileInput } from '../src/shared/api';

const USAGE = `Usage:
  migrate                                   apply database migrations (safe to repeat)
  seed                                      import the bundled track files in seed/ (safe to repeat)
  import-questions <files…> [--dry-run] [--track <id>]
                                            import track files (.json) and CSV files (.csv);
                                            --track names the track for CSV files
  dev-users                                 development only: add an organiser and an interviewer`;

function args(argv: string[]) {
  const files: string[] = [];
  let dryRun = false;
  let track: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--track') track = argv[++i];
    else if (a.startsWith('--track=')) track = a.slice(8);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}\n${USAGE}`);
    else files.push(a);
  }
  return { files, dryRun, track };
}

const SYSTEM = (what: string) => ({ system: `system (${what})` });

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    return;
  }
  const cfg = loadDatabaseConfig();
  const pool = createPool({ databaseUrl: cfg.databaseUrl, databasePassword: cfg.databasePassword, max: 2, applicationName: `interview-assistant-${command}` });
  const db = createDb(pool);
  try {
    switch (command) {
      case 'migrate': {
        const r = await migrate(pool, cfg.migrationsDir, (l) => console.log(l));
        console.log(r.applied.length ? `Applied ${r.applied.length} migration(s); the database is up to date.` : `Nothing to apply: all ${r.alreadyApplied} migrations are already applied.`);
        break;
      }
      case 'seed':
      case 'import-questions': {
        const { files, dryRun, track } = args(rest);
        const paths = command === 'seed' ? readdirSync(cfg.seedDir).filter((f) => f.endsWith('.json')).sort().map((f) => join(cfg.seedDir, f)) : files;
        if (command === 'import-questions' && !paths.length) throw new Error(`Name at least one file.\n${USAGE}`);
        const inputs: ImportFileInput[] = paths.map((p) => ({ name: basename(p), text: readFileSync(p, 'utf8'), ...(track ? { trackId: track } : {}) }));
        const report = await importQuestions(db, SYSTEM(command === 'seed' ? 'npm run db:seed' : 'npm run db:import-questions'), inputs, { dryRun: command === 'seed' ? false : dryRun });
        console.log(formatReport(report));
        if (!report.ok) process.exitCode = 1;
        break;
      }
      case 'dev-users': {
        if (process.env.NODE_ENV === 'production') throw new Error('dev-users is for development databases only.');
        for (const [email, role, name] of [
          ['organiser@example.test', 'organiser', 'Olive Organiser'],
          ['interviewer@example.test', 'interviewer', 'Ian Interviewer'],
        ] as const) {
          const r = await db.insertInto('users').values({ email, role, name }).onConflict((oc) => oc.column('email').doNothing()).returning('id').executeTakeFirst();
          if (r) await appendAudit(db, SYSTEM('npm run db:dev-users'), { action: 'user.added', entity: 'user', entityId: r.id, after: { email, role } });
          console.log(r ? `Added ${email} (${role})` : `${email} already exists`);
        }
        console.log('Sign in as a BOOTSTRAP_ADMINS address to be an administrator.');
        break;
      }
      default:
        throw new Error(`Unknown command "${command}"\n${USAGE}`);
    }
  } finally {
    await db.destroy();
    // Kysely only ends the pool if it used it; migrate uses the pool directly.
    if (!pool.ended) await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `Error: ${(err as Error).message}`);
  process.exit(1);
});
