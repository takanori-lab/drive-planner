import { ApiError } from './errors';

const TOKEN_VERSION = 1;
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export interface SessionClaims {
  version: number;
  issuedAt: number;
  expiresAt: number;
  sessionId: string;
}

function configured(value: string | undefined): string {
  if (!value) throw new Error('Worker secret is not configured');
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(configured(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signature(value: string, secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function passcodeMatches(submitted: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(configured(expected)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [submittedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(submitted)),
    crypto.subtle.sign('HMAC', key, encoder.encode(expected)),
  ]);
  return constantTimeEqual(new Uint8Array(submittedDigest), new Uint8Array(expectedDigest));
}

export async function createSessionToken(secret: string, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = SESSION_TTL_SECONDS): Promise<{ token: string; claims: SessionClaims }> {
  configured(secret);
  const claims: SessionClaims = {
    version: TOKEN_VERSION,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    sessionId: crypto.randomUUID(),
  };
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  return { token: `${payload}.${base64url(await signature(payload, secret))}`, claims };
}

function unauthorized(): never {
  throw new ApiError(401, 'unauthorized', '認証が必要です。');
}

export async function verifySessionToken(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SessionClaims> {
  try {
    configured(secret);
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return unauthorized();
    const actual = decodeBase64url(parts[1]);
    const expected = await signature(parts[0], secret);
    if (!constantTimeEqual(actual, expected)) return unauthorized();
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0]))) as Record<string, unknown>;
    if (Object.keys(claims).length !== 4
      || claims.version !== TOKEN_VERSION
      || !Number.isInteger(claims.issuedAt)
      || !Number.isInteger(claims.expiresAt)
      || typeof claims.sessionId !== 'string'
      || !/^[0-9a-f-]{36}$/iu.test(claims.sessionId)
      || (claims.issuedAt as number) > nowSeconds + 60
      || (claims.expiresAt as number) <= nowSeconds
      || (claims.expiresAt as number) - (claims.issuedAt as number) > SESSION_TTL_SECONDS) return unauthorized();
    return claims as unknown as SessionClaims;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (!secret) throw error;
    return unauthorized();
  }
}
