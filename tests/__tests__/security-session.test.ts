import { SessionRevocationManager } from '@/lib/security/session';
import CacheManager from '@/lib/cache-manager';

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

describe('SessionRevocationManager', () => {
  let manager: SessionRevocationManager;

  beforeEach(() => {
    manager = new SessionRevocationManager();
  });

  it('identifies tokens issued before revocation as stale', async () => {
    const actorId = 'user-123';
    const beforeRevocation = Date.now() - 10000;

    await manager.revokeSession(actorId, 'password_reset');

    expect(await manager.isSessionStale(actorId, beforeRevocation)).toBe(true);
  });

  it('identifies tokens issued after revocation as fresh', async () => {
    const actorId = 'user-123';

    const cache = CacheManager.getInstance();
    await cache.putResponse('api', new Request(`https://internal/revocations/${actorId}`), new Response(JSON.stringify({
      actorId,
      revokedAt: Date.now() - 10000,
      reason: 'password_reset'
    })));

    const afterRevocation = Date.now();

    expect(await manager.isSessionStale(actorId, afterRevocation)).toBe(false);
  });

  it('identifies tokens as fresh if no revocation exists', async () => {
    expect(await manager.isSessionStale('user-unknown', Date.now())).toBe(false);
  });
});
