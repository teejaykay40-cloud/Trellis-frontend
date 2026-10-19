import { issueActorToken, ACTOR_TOKEN_SECRET_ENV } from '@/lib/auth/actor';

const mockSecret = 'this-is-a-super-secret-key-that-is-at-least-32-bytes-long';
process.env[ACTOR_TOKEN_SECRET_ENV] = mockSecret;

const crypto = require('crypto');
Object.defineProperty(global, 'crypto', {
  value: {
    subtle: crypto.webcrypto.subtle
  }
});

class MockRequest {
  constructor(input, init) {
    this.url = input;
    this.method = init?.method || 'GET';
    this.headers = new Headers(init?.headers);
  }
}
global.Request = MockRequest;

global.Response = class MockResponse {
  constructor(body, init) {
    this.body = body;
    this.status = init?.status || 200;
  }
  async json() {
    return JSON.parse(this.body);
  }
  clone() {
    return new MockResponse(this.body, {status: this.status});
  }
  async text() {
    return this.body;
  }
  static json(body, init) {
    return new MockResponse(JSON.stringify(body), init);
  }
};

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body, init) => {
      return { body, status: init?.status || 200 };
    })
  }
}));

import { requireActor, requirePermission } from '@/lib/auth/guard';
import { globalSessionRevocationManager } from '@/lib/auth/guard';

jest.mock('@/lib/cache-manager', () => {
  const map = new Map();
  return {
    __esModule: true,
    default: {
      getInstance: () => ({
        putResponse: jest.fn(async (ns, req, res) => {
          map.set(req.url, await res.clone().text());
        }),
        getCachedResponse: jest.fn(async (ns, req) => {
          const text = map.get(req.url);
          return text ? new Response(text) : undefined;
        })
      })
    }
  };
});

describe('guard authentication', () => {
  it('rejects an actor with a revoked session', async () => {
    const actorId = 'user-revoked-123';
    const token = await issueActorToken({ id: actorId, role: 'contributor' });

    // Revoke the session after the token was issued
    await globalSessionRevocationManager.revokeSession(actorId, 'security_breach');

    const request = { headers: new Map([['authorization', `Bearer ${token}`]]) };

    const result = await requireActor({ headers: { get: (name) => request.headers.get(name) || null } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it('rejects permission requirement for an actor with a revoked session', async () => {
    const actorId = 'user-revoked-456';
    const token = await issueActorToken({ id: actorId, role: 'contributor' });

    // Revoke the session after the token was issued
    await globalSessionRevocationManager.revokeSession(actorId, 'password_reset');

    const request = { headers: new Map([['authorization', `Bearer ${token}`]]) };

    const result = await requirePermission(
      { headers: { get: (name) => request.headers.get(name) || null } },
      { action: 'view_telemetry' }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it('accepts an actor without a revoked session', async () => {
    const actorId = 'user-valid-123';
    const token = await issueActorToken({ id: actorId, role: 'contributor' });

    const request = { headers: new Map([['authorization', `Bearer ${token}`]]) };

    const result = await requireActor({ headers: { get: (name) => request.headers.get(name) || null } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.id).toBe(actorId);
    }
  });

  it('accepts permission requirement for an actor without a revoked session', async () => {
    const actorId = 'user-valid-456';
    const token = await issueActorToken({ id: actorId, role: 'admin' });

    const request = { headers: new Map([['authorization', `Bearer ${token}`]]) };

    const result = await requirePermission(
      { headers: { get: (name) => request.headers.get(name) || null } },
      { action: 'view_telemetry' }
    );

    if (!result.ok) {
      expect(result.status).not.toBe(401);
    } else {
      expect(result.ok).toBe(true);
    }
  });
});
