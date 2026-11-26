// HOST-3: all configuration comes from environment variables, documented in .env.example. The
// server refuses to start with a clear message when a setting is missing or unsafe. Secret values
// are never logged: `describeConfig` prints only which settings are present.
import { z } from 'zod';

export interface Config {
  production: boolean;
  port: number;
  host: string;
  /** The address people use, e.g. https://interviews.example.com (no trailing slash). */
  publicUrl: string;
  publicOrigin: string;
  /** Cookies get `Secure` and the `__Host-` prefix when the public URL is https. */
  secureCookies: boolean;
  databaseUrl: string;
  databasePassword: string | undefined;
  databasePoolMax: number;
  google: { clientId: string; clientSecret: string } | null;
  sessionSecret: string;
  sessionIdleMs: number;
  sessionMaxMs: number;
  bootstrapAdmins: string[];
  devSignIn: boolean;
  trustProxy: boolean;
  logLevel: string;
  /** Where the built browser app is (index.html and assets). */
  staticDir: string;
  migrationsDir: string;
  seedDir: string;
  /** SSE streams end after this long so they rotate well before the platform's request timeout. */
  liveStreamMaxMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Interview Assistant cannot start. Fix these settings (see .env.example):\n  - ${problems.join('\n  - ')}`);
  }
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v.trim()));
const EMAIL = z.email();

/** Parses and checks the environment. Throws ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';
  const get = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };

  const port = Number(get('PORT') ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('PORT must be a port number.');

  let publicUrl = get('PUBLIC_URL') ?? (production ? '' : `http://localhost:${port}`);
  let publicOrigin = '';
  if (!publicUrl) problems.push('PUBLIC_URL is required in production (for example https://interviews.example.com).');
  else {
    try {
      const u = new URL(publicUrl);
      if (u.pathname !== '/' || u.search || u.hash) problems.push('PUBLIC_URL must be an origin only, with no path (for example https://interviews.example.com).');
      if (production && u.protocol !== 'https:') problems.push('PUBLIC_URL must use https in production.');
      publicOrigin = u.origin;
      publicUrl = u.origin;
    } catch {
      problems.push('PUBLIC_URL is not a valid URL.');
    }
  }

  const databaseUrl = get('DATABASE_URL') ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is required (for example postgres://ia@127.0.0.1:54329/ia_dev).');

  const clientId = get('GOOGLE_CLIENT_ID');
  const clientSecret = get('GOOGLE_CLIENT_SECRET');
  if (!!clientId !== !!clientSecret) problems.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.');

  const devSignIn = bool(get('DEV_SIGN_IN'), false);
  if (devSignIn && production) problems.push('DEV_SIGN_IN must not be enabled when NODE_ENV=production (AUTH-6).');
  if (production && !clientId) problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production.');
  if (!production && !clientId && !devSignIn) problems.push('Nobody could sign in: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or DEV_SIGN_IN=true for development.');

  const sessionSecret = get('SESSION_SECRET') ?? '';
  if (sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters (for example: openssl rand -base64 48).');

  const idleHours = Number(get('SESSION_IDLE_HOURS') ?? 12);
  if (!(idleHours > 0 && idleHours <= 24 * 30)) problems.push('SESSION_IDLE_HOURS must be a number of hours between 0 and 720.');
  const maxDays = Number(get('SESSION_MAX_DAYS') ?? 7);
  if (!(maxDays > 0 && maxDays <= 90)) problems.push('SESSION_MAX_DAYS must be a number of days between 0 and 90.');

  const bootstrapAdmins = (get('BOOTSTRAP_ADMINS') ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const e of bootstrapAdmins) if (!EMAIL.safeParse(e).success) problems.push(`BOOTSTRAP_ADMINS: "${e}" is not an email address.`);
  if (production && !bootstrapAdmins.length) problems.push('BOOTSTRAP_ADMINS must name at least one administrator email in production (AUTH-3).');

  const poolMax = Number(get('DATABASE_POOL_MAX') ?? 10);
  if (!(Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 100)) problems.push('DATABASE_POOL_MAX must be a whole number from 1 to 100.');

  const liveMin = Number(get('LIVE_STREAM_MAX_MINUTES') ?? 15);
  if (!(liveMin > 0 && liveMin <= 55)) problems.push('LIVE_STREAM_MAX_MINUTES must be between 0 and 55 (below the Cloud Run request timeout).');

  if (problems.length) throw new ConfigError(problems);
  return {
    production,
    port,
    host: get('HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    publicOrigin,
    secureCookies: publicUrl.startsWith('https:'),
    databaseUrl,
    databasePassword: get('DB_PASSWORD'),
    databasePoolMax: poolMax,
    google: clientId && clientSecret ? { clientId, clientSecret } : null,
    sessionSecret,
    sessionIdleMs: idleHours * 3_600_000,
    sessionMaxMs: maxDays * 86_400_000,
    bootstrapAdmins,
    devSignIn,
    trustProxy: bool(get('TRUST_PROXY'), production),
    logLevel: get('LOG_LEVEL') ?? (production ? 'info' : 'info'),
    staticDir: get('STATIC_DIR') ?? 'dist/client',
    migrationsDir: get('MIGRATIONS_DIR') ?? 'server/db/migrations',
    seedDir: get('SEED_DIR') ?? 'seed',
    liveStreamMaxMs: liveMin * 60_000,
  };
}

/** Only the database settings, for the command-line scripts (migrate, seed, import). */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, 'databaseUrl' | 'databasePassword' | 'databasePoolMax' | 'migrationsDir' | 'seedDir'> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new ConfigError(['DATABASE_URL is required (for example postgres://ia@127.0.0.1:54329/ia_dev).']);
  return {
    databaseUrl,
    databasePassword: env.DB_PASSWORD?.trim() || undefined,
    databasePoolMax: 2,
    migrationsDir: env.MIGRATIONS_DIR?.trim() || 'server/db/migrations',
    seedDir: env.SEED_DIR?.trim() || 'seed',
  };
}

/** HOST-3: what is configured, without any secret value (safe to log at startup). */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    production: c.production,
    publicUrl: c.publicUrl,
    googleSignIn: !!c.google,
    devSignIn: c.devSignIn,
    bootstrapAdmins: c.bootstrapAdmins.length,
    sessionIdleHours: c.sessionIdleMs / 3_600_000,
    trustProxy: c.trustProxy,
  };
}
