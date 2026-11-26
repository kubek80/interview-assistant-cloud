// AUTH-1: Google sign-in with OpenID Connect, authorization-code flow with PKCE, entirely on the
// server. The library (openid-client) discovers Google's endpoints, exchanges the code with the
// client secret and PKCE verifier, checks `state`, and verifies the ID token (signature from
// Google's keys, issuer, audience, expiry, nonce). `checkClaims` then repeats the checks this app
// depends on and adds its own (verified email), so a library mistake or misconfiguration cannot
// silently admit someone, and so they can be unit-tested with a stand-in provider.
import * as oidc from 'openid-client';

export interface IdClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

export interface OidcProvider {
  /** The issuer every ID token must name. */
  readonly issuer: string;
  readonly clientId: string;
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  /** Completes the code exchange for the callback URL; returns the verified ID token claims. */
  exchange(p: { callbackUrl: URL; redirectUri: string; codeVerifier: string; state: string; nonce: string }): Promise<IdClaims>;
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';

export function createOidcProvider(o: { issuer: string; clientId: string; clientSecret: string; allowInsecureForTests?: boolean }): OidcProvider {
  let configP: Promise<oidc.Configuration> | null = null;
  const config = () => {
    configP ??= oidc
      .discovery(new URL(o.issuer), o.clientId, o.clientSecret, undefined, o.allowInsecureForTests ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((err: unknown) => {
        configP = null; // try discovery again next time
        throw err;
      });
    return configP;
  };
  return {
    issuer: o.issuer,
    clientId: o.clientId,
    async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      return oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      });
    },
    async exchange({ callbackUrl, codeVerifier, state, nonce, redirectUri }) {
      const tokens = await oidc.authorizationCodeGrant(await config(), callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      }, { redirect_uri: redirectUri });
      const claims = tokens.claims();
      if (!claims) throw new Error('no ID token');
      return claims as IdClaims;
    },
  };
}

export const randomPkceVerifier = () => oidc.randomPKCECodeVerifier();
export const pkceChallenge = (verifier: string) => oidc.calculatePKCECodeChallenge(verifier);

export type RefusalReason = 'wrong_issuer' | 'wrong_audience' | 'expired' | 'nonce_mismatch' | 'no_email' | 'email_not_verified' | 'no_subject';

export class SignInRefused extends Error {
  constructor(public readonly reason: RefusalReason | 'not_invited' | 'deactivated' | 'account_mismatch' | 'state_mismatch' | 'flow_expired' | 'provider_error') {
    super(reason);
  }
}

export interface CheckedIdentity {
  sub: string;
  email: string;
  name: string | null;
}

/** AUTH-1, AUTH-2: the ID token claims this app relies on. Throws SignInRefused. */
export function checkClaims(claims: IdClaims, expected: { issuer: string; clientId: string; nonce: string; now?: number }): CheckedIdentity {
  const issuers = expected.issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, 'accounts.google.com'] : [expected.issuer];
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) throw new SignInRefused('wrong_issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.clientId)) throw new SignInRefused('wrong_audience');
  if (aud.length > 1 && claims.azp !== expected.clientId) throw new SignInRefused('wrong_audience');
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new SignInRefused('expired');
  if (claims.nonce !== expected.nonce) throw new SignInRefused('nonce_mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new SignInRefused('no_subject');
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new SignInRefused('no_email');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new SignInRefused('email_not_verified');
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : null;
  return { sub: claims.sub, email: claims.email.trim().toLowerCase(), name };
}
