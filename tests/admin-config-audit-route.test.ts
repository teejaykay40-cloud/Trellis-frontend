/** @jest-environment node */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/feature-flags/emergency-disable/route';
import { issueActorToken } from '@/lib/auth';
import { securityAuditLedger } from '@/lib/security/audit-ledger';

const streamId = 'admin-config:global';
const secret = 'test-only-secret-that-is-at-least-32-characters';

describe('administrative configuration audit evidence', () => {
  const previousSecret = process.env.PERMISSION_TOKEN_SECRET;

  beforeEach(() => { process.env.PERMISSION_TOKEN_SECRET = secret; });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.PERMISSION_TOKEN_SECRET;
    else process.env.PERMISSION_TOKEN_SECRET = previousSecret;
  });

  async function send(role: 'admin' | 'contributor', disabled = true) {
    const token = await issueActorToken({ id: `${role}-1`, role });
    return POST(new NextRequest('https://example.test/api/feature-flags/emergency-disable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ flag: 'securityReportExport', disabled, confirm: true }),
    }));
  }

  it('records an authorized change and an authorization denial in the verified chain', async () => {
    const before = securityAuditLedger.getEntries(streamId).length;
    expect((await send('admin')).status).toBe(200);
    expect((await send('contributor', false)).status).toBe(403);
    const entries = securityAuditLedger.getEntries(streamId).slice(before);
    expect(entries.map((entry) => entry.eventType)).toEqual([
      'admin.config.change.attempted',
      'admin.config.change.succeeded',
      'admin.config.change.denied',
    ]);
    expect(entries[0].payload).toEqual({ setting: 'featureFlag.securityReportExport', requestedValue: true });
    expect(securityAuditLedger.export(streamId).verification.valid).toBe(true);
  });

  it('retains retries as separate attempts while applying the same requested state', async () => {
    const before = securityAuditLedger.getEntries(streamId).length;
    expect((await send('admin', false)).status).toBe(200);
    expect((await send('admin', false)).status).toBe(200);
    const entries = securityAuditLedger.getEntries(streamId).slice(before);
    expect(entries.filter((entry) => entry.eventType === 'admin.config.change.attempted')).toHaveLength(2);
    expect(entries.filter((entry) => entry.eventType === 'admin.config.change.succeeded')).toHaveLength(2);
  });
});
