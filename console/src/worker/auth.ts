import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './types.js';

const keySets = new Map<string, JWTVerifyGetKey>();

/** An injected key resolver is used by cryptographic unit tests, never by HTTP routes. */
export async function verifyAccessIdentity(token: string, env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'OWNER_EMAIL'>, resolver?: JWTVerifyGetKey): Promise<{ email: string }> {
  const domain = new URL(env.ACCESS_TEAM_DOMAIN);
  if (domain.protocol !== 'https:' || domain.username || domain.password || domain.port || domain.pathname !== '/' || domain.search || domain.hash || !domain.hostname.endsWith('.cloudflareaccess.com')) throw new Error('Access configuration is invalid.');
  if (!env.ACCESS_AUD || !env.OWNER_EMAIL) throw new Error('Access configuration is incomplete.');
  const issuer = domain.origin;
  let keys = resolver ?? keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), { cooldownDuration: 30_000, timeoutDuration: 5000 });
    keySets.set(issuer, keys);
  }
  const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'], clockTolerance: 5 });
  if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase()) throw new Error('Owner sign-in is required.');
  return { email: payload.email };
}

export async function ownerIdentity(request: Request, env: Env): Promise<{ email: string }> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16_384) throw new Error('Sign in with Cloudflare Access.');
  return verifyAccessIdentity(token, env);
}

export async function hashSecret(secret: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sameHash(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
