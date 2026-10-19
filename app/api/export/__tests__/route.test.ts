/** @jest-environment node */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/export/route';
import { issueActorToken } from '@/lib/auth';

const wallet = 'G'.repeat(56);
const secret = 'test-only-secret-that-is-at-least-32-characters';

describe('POST /api/export authorization', () => {
  const previousSecret = process.env.PERMISSION_TOKEN_SECRET;

  beforeEach(() => {
    process.env.PERMISSION_TOKEN_SECRET = secret;
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.PERMISSION_TOKEN_SECRET;
    else process.env.PERMISSION_TOKEN_SECRET = previousSecret;
  });

  async function send(role?: 'admin' | 'viewer') {
    const authorization = role
      ? `Bearer ${await issueActorToken({ id: wallet, role })}`
      : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;

    return POST(new NextRequest('https://example.test/api/export', {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallet, type: 'simulations', format: 'json' }),
    }));
  }

  it('denies callers without a signed identity and roles without export permission', async () => {
    expect((await send()).status).toBe(401);
    expect((await send('viewer')).status).toBe(403);
  });

  it('returns a successful empty export for an authorized caller', async () => {
    const response = await send('admin');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[\n\n]');
  });
});
