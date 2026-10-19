import { z } from 'zod';
import { ACTOR_TOKEN_SECRET_ENV } from '@/lib/auth/actor';
import type { Action } from '@/lib/permissions';

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;
const textEncoder = new TextEncoder();

const CapabilityPayloadSchema = z.object({
  sub: z.string().min(1),
  action: z.literal('run_retention_cleanup'),
  requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  jti: z.string().min(20),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export interface CapabilityExpectation {
  actorId: string;
  action: Action;
  requestHash: string;
}

export type CapabilityVerification =
  | { ok: true; expiresAt: number }
  | {
      ok: false;
      failure:
        | 'missing_token'
        | 'malformed_token'
        | 'invalid_signature'
        | 'expired_token'
        | 'action_mismatch'
        | 'actor_mismatch'
        | 'request_mismatch'
        | 'server_misconfigured';
    };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function resolveSecret(): string | null {
  const secret = process.env[ACTOR_TOKEN_SECRET_ENV];
  return secret && secret.length >= 32 ? secret : null;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(message)));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function fingerprintCapabilityRequest(
  action: Action,
  request: Record<string, unknown>,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(canonicalize({ action, request })),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export async function issueCapabilityToken(
  input: CapabilityExpectation,
  options: { ttlMs?: number; now?: number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const secret = resolveSecret();
  if (!secret) {
    throw new Error(`${ACTOR_TOKEN_SECRET_ENV} is unset or shorter than 32 characters`);
  }
  if (input.action !== 'run_retention_cleanup' || !input.actorId || !input.requestHash) {
    throw new Error('Capability must be bound to an actor, supported action, and request');
  }

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
    throw new Error(`Capability lifetime must be between 1000 and ${MAX_TTL_MS} milliseconds`);
  }
  const now = options.now ?? Date.now();
  const expiresAt = now + ttlMs;
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const payload = CapabilityPayloadSchema.parse({
    sub: input.actorId,
    action: input.action,
    requestHash: input.requestHash,
    jti: base64UrlEncode(nonce),
    iat: now,
    exp: expiresAt,
  });
  const encoded = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, encoded));
  return { token: `${encoded}.${signature}`, expiresAt };
}

export async function verifyCapabilityToken(
  token: string | null,
  expected: CapabilityExpectation,
  options: { now?: number } = {},
): Promise<CapabilityVerification> {
  if (!token) return { ok: false, failure: 'missing_token' };
  if (token.length > 4096) return { ok: false, failure: 'malformed_token' };
  const secret = resolveSecret();
  if (!secret) return { ok: false, failure: 'server_misconfigured' };

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, failure: 'malformed_token' };
  }

  let provided: Uint8Array;
  let decodedPayload: Uint8Array;
  try {
    provided = base64UrlDecode(parts[1]);
    decodedPayload = base64UrlDecode(parts[0]);
  } catch {
    return { ok: false, failure: 'malformed_token' };
  }
  const signature = await hmac(secret, parts[0]);
  if (!timingSafeEqual(signature, provided)) {
    return { ok: false, failure: 'invalid_signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodedPayload));
  } catch {
    return { ok: false, failure: 'malformed_token' };
  }
  const parsed = CapabilityPayloadSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.exp <= parsed.data.iat ||
    parsed.data.exp - parsed.data.iat > MAX_TTL_MS
  ) {
    return { ok: false, failure: 'malformed_token' };
  }
  if (parsed.data.exp <= (options.now ?? Date.now())) {
    return { ok: false, failure: 'expired_token' };
  }
  if (parsed.data.action !== expected.action) {
    return { ok: false, failure: 'action_mismatch' };
  }
  if (parsed.data.sub !== expected.actorId) {
    return { ok: false, failure: 'actor_mismatch' };
  }
  if (parsed.data.requestHash !== expected.requestHash) {
    return { ok: false, failure: 'request_mismatch' };
  }

  return { ok: true, expiresAt: parsed.data.exp };
}
