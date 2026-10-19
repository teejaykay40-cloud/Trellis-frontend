import { issueActorToken, verifyActorToken, ACTOR_TOKEN_SECRET_ENV } from '@/lib/auth/actor';

const mockSecret = 'this-is-a-super-secret-key-that-is-at-least-32-bytes-long';
process.env[ACTOR_TOKEN_SECRET_ENV] = mockSecret;

const crypto = require('crypto');
Object.defineProperty(global, 'crypto', {
  value: {
    subtle: crypto.webcrypto.subtle
  }
});

describe('actor authentication', () => {
  it('issues and verifies a valid token', async () => {
    const token = await issueActorToken({ id: 'user-1', role: 'contributor' });
    const result = await verifyActorToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.id).toBe('user-1');
      expect(result.actor.role).toBe('contributor');
      expect(result.actor.issuedAt).toBeDefined();
    }
  });

  it('rejects an expired token', async () => {
    const now = Date.now();
    const token = await issueActorToken({ id: 'user-1', role: 'contributor' }, { now, ttlMs: 1000 });

    const result = await verifyActorToken(token, { now: now + 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('expired_token');
    }
  });

  it('rejects a token with an invalid signature', async () => {
    const token = await issueActorToken({ id: 'user-1', role: 'contributor' });
    const [payload, signature] = token.split('.');

    // Modify signature
    const invalidSignature = signature.substring(0, signature.length - 1) + 'A';

    const result = await verifyActorToken(`${payload}.${invalidSignature}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('invalid_signature');
    }
  });
});
