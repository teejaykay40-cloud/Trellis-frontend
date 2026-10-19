import CacheManager from '@/lib/cache-manager';

export interface SessionRevocation {
  actorId: string;
  revokedAt: number;
  reason: string;
}

export class SessionRevocationManager {
  private readonly CACHE_NAMESPACE = 'api'; // Using one of the pre-configured CacheTypes

  async revokeSession(actorId: string, reason: string): Promise<void> {
    const revocation: SessionRevocation = {
      actorId,
      revokedAt: Date.now(),
      reason,
    };

    // We construct a mock request to key into the cache manager
    const request = new Request(`https://internal/revocations/${actorId}`);
    const response = new Response(JSON.stringify(revocation), {
      headers: { 'Content-Type': 'application/json' }
    });

    const cache = CacheManager.getInstance();
    await cache.putResponse(this.CACHE_NAMESPACE, request, response);
  }

  async isSessionStale(actorId: string, tokenIssuedAt: number): Promise<boolean> {
    const request = new Request(`https://internal/revocations/${actorId}`);

    const cache = CacheManager.getInstance();
    const response = await cache.getCachedResponse(this.CACHE_NAMESPACE, request);

    if (!response) {
      return false;
    }

    try {
      // Need to clone the response before reading JSON as the body stream can only be read once
      const clonedResponse = response.clone();
      const revocation = await clonedResponse.json() as SessionRevocation;
      return tokenIssuedAt < revocation.revokedAt;
    } catch (e) {
      return false;
    }
  }
}
