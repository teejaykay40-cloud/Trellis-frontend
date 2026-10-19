/** @jest-environment node */
import { NextRequest } from 'next/server';
import { API_CONTRACTS, validateContractSchema } from '@/lib/api-contracts/schemas';
import { GET as getBugReports, POST as postBugReport } from '@/app/api/bug-reports/route';
import { GET as getDeadLetters, POST as postDeadLetter } from '@/app/api/retry/dead-letters/route';
import { POST as postExport } from '@/app/api/export/route';
import { deadLetterQueue, classifyError } from '@/lib/retry';
import { issueActorToken } from '@/lib/auth';

const ADMIN_TOKEN = 'test-dead-letter-admin-secret-token-32-chars';
const PERMISSION_SECRET = 'test-permission-token-secret-32-chars-long';
const TEST_WALLET = 'G'.repeat(56);

describe('Contract Tests: Pagination, Filtering & Authorization Boundaries (Issue #323)', () => {
  const originalDeadLetterToken = process.env.DEAD_LETTER_ADMIN_TOKEN;
  const originalPermissionSecret = process.env.PERMISSION_TOKEN_SECRET;

  beforeEach(() => {
    process.env.DEAD_LETTER_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.PERMISSION_TOKEN_SECRET = PERMISSION_SECRET;
  });

  afterAll(() => {
    if (originalDeadLetterToken !== undefined) {
      process.env.DEAD_LETTER_ADMIN_TOKEN = originalDeadLetterToken;
    } else {
      delete process.env.DEAD_LETTER_ADMIN_TOKEN;
    }

    if (originalPermissionSecret !== undefined) {
      process.env.PERMISSION_TOKEN_SECRET = originalPermissionSecret;
    } else {
      delete process.env.PERMISSION_TOKEN_SECRET;
    }
  });

  // =========================================================================
  // 1. PAGINATION CONTRACT BOUNDARIES
  // =========================================================================
  describe('Pagination Contract Boundaries', () => {
    it('GET /api/bug-reports satisfies cursor pagination contract on normal forward traversal', async () => {
      const contract = API_CONTRACTS['GET /api/bug-reports'];

      // Populate sample bug reports if empty
      const formData = new FormData();
      formData.set('title', 'Pagination Bug 1');
      formData.set('description', 'Test Description');
      formData.set('stepsToReproduce', '1. Do step');
      formData.set('expectedBehavior', 'Expected');
      formData.set('actualBehavior', 'Actual');
      formData.set('priority', 'medium');
      formData.set('category', 'functionality');
      formData.set('agreeToTerms', 'true');

      const submitReq = new NextRequest('http://localhost:3000/api/bug-reports', {
        method: 'POST',
        body: formData,
        headers: { origin: 'http://localhost:3000' },
      });
      await postBugReport(submitReq);

      // Page 1 query
      const req = new NextRequest('http://localhost:3000/api/bug-reports?limit=10&status=all');
      const response = await getBugReports(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      const validation = validateContractSchema(data, contract.responseSchema);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(Array.isArray(data.bugReports)).toBe(true);
      expect(typeof data.total).toBe('number');
    });

    it('GET /api/retry/dead-letters enforces upper boundary limit contract (limit <= 200)', async () => {
      // Valid limit at boundary (limit=200)
      const validReq = new NextRequest('http://localhost:3000/api/retry/dead-letters?limit=200', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const validRes = await getDeadLetters(validReq);
      expect(validRes.status).toBe(200);
      const validData = await validRes.json();
      const validation = validateContractSchema(validData, API_CONTRACTS['GET /api/retry/dead-letters'].responseSchema);
      expect(validation.valid).toBe(true);

      // Exceeded limit boundary (limit=201)
      const invalidReq = new NextRequest('http://localhost:3000/api/retry/dead-letters?limit=201', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const invalidRes = await getDeadLetters(invalidReq);
      expect(invalidRes.status).toBe(400);
      const invalidData = await invalidRes.json();
      expect(invalidData.error).toBe('invalid_limit');
      expect(invalidData.message).toContain('between 1 and 200');
    });

    it('GET /api/retry/dead-letters rejects non-positive or non-integer limit', async () => {
      const zeroReq = new NextRequest('http://localhost:3000/api/retry/dead-letters?limit=0', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const zeroRes = await getDeadLetters(zeroReq);
      expect(zeroRes.status).toBe(400);
      expect((await zeroRes.json()).error).toBe('invalid_limit');

      const nonIntReq = new NextRequest('http://localhost:3000/api/retry/dead-letters?limit=abc', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const nonIntRes = await getDeadLetters(nonIntReq);
      expect(nonIntRes.status).toBe(400);
      expect((await nonIntRes.json()).error).toBe('invalid_limit');
    });
  });

  // =========================================================================
  // 2. FILTERING CONTRACT BOUNDARIES
  // =========================================================================
  describe('Filtering Contract Boundaries', () => {
    it('GET /api/retry/dead-letters filters by valid reason and operationClass', async () => {
      // Seed dead-letter queue
      deadLetterQueue.record({
        operationClass: 'transaction',
        operationId: 'op_filter_test',
        reason: 'retries_exhausted',
        classification: classifyError(new Error('Simulation network failed')),
        attempts: [],
        context: { test: true },
      });

      const req = new NextRequest(
        'http://localhost:3000/api/retry/dead-letters?reason=retries_exhausted&operationClass=transaction&includeResolved=true',
        {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }
      );
      const response = await getDeadLetters(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      const validation = validateContractSchema(data, API_CONTRACTS['GET /api/retry/dead-letters'].responseSchema);
      expect(validation.valid).toBe(true);
      expect(data.records.every((r: any) => r.reason === 'retries_exhausted')).toBe(true);
      expect(data.records.every((r: any) => r.operationClass === 'transaction')).toBe(true);
    });

    it('GET /api/retry/dead-letters rejects invalid filter values with 400 contract schema', async () => {
      // Invalid reason
      const invalidReasonReq = new NextRequest(
        'http://localhost:3000/api/retry/dead-letters?reason=non_existent_reason',
        { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }
      );
      const res1 = await getDeadLetters(invalidReasonReq);
      expect(res1.status).toBe(400);
      const data1 = await res1.json();
      expect(data1.error).toBe('invalid_reason');

      // Invalid operationClass
      const invalidClassReq = new NextRequest(
        'http://localhost:3000/api/retry/dead-letters?operationClass=malicious_unregistered_class',
        { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }
      );
      const res2 = await getDeadLetters(invalidClassReq);
      expect(res2.status).toBe(400);
      const data2 = await res2.json();
      expect(data2.error).toBe('invalid_operation_class');
    });
  });

  // =========================================================================
  // 3. AUTHORIZATION BOUNDARIES & PERMISSION GATES
  // =========================================================================
  describe('Authorization Boundaries & Permission Gates', () => {
    it('GET /api/retry/dead-letters rejects requests without Authorization header (401)', async () => {
      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters');
      const response = await getDeadLetters(req);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('unauthorized');
      expect(data.message).toContain('DEAD_LETTER_ADMIN_TOKEN');
    });

    it('GET /api/retry/dead-letters rejects invalid or forged bearer tokens (401)', async () => {
      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        headers: { authorization: 'Bearer forged-invalid-token-value' },
      });
      const response = await getDeadLetters(req);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('unauthorized');
    });

    it('GET /api/retry/dead-letters fails closed (503) when secret is unconfigured', async () => {
      delete process.env.DEAD_LETTER_ADMIN_TOKEN;

      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        headers: { authorization: 'Bearer any-token' },
      });
      const response = await getDeadLetters(req);

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('not_configured');
      expect(data.message).toContain('DEAD_LETTER_ADMIN_TOKEN is not set');
    });

    it('POST /api/export rejects unauthorized actor roles with 403 Forbidden boundary', async () => {
      // Role 'viewer' has no data export permission
      const viewerToken = await issueActorToken({ id: TEST_WALLET, role: 'viewer' as any });

      const req = new NextRequest('http://localhost:3000/api/export', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          wallet: TEST_WALLET,
          type: 'simulations',
        }),
      });

      const response = await postExport(req);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe('denied_by_policy');
    });

    it('POST /api/export rejects unauthenticated requests with 401 Unauthorized', async () => {
      const req = new NextRequest('http://localhost:3000/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet: TEST_WALLET,
          type: 'simulations',
        }),
      });

      const response = await postExport(req);
      expect(response.status).toBe(401);
    });
  });

  // =========================================================================
  // 4. RETRY PATHS & RECOVERY STATE TRANSITIONS
  // =========================================================================
  describe('Retry Paths & Recovery State Transitions', () => {
    it('POST /api/retry/dead-letters successfully transitions a dead-letter item to replayed', async () => {
      const contract = API_CONTRACTS['POST /api/retry/dead-letters'];

      // Enqueue record
      const record = deadLetterQueue.record({
        operationClass: 'transaction',
        operationId: 'op_replay_test',
        reason: 'retries_exhausted',
        classification: classifyError(new Error('Simulation failed')),
        attempts: [],
        context: { testRunId: 'tr-123' },
      });

      // Submit retry action
      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          id: record.id,
          outcome: 'replayed',
          notes: 'Automated retry verification via contract test suite',
        }),
      });

      const response = await postDeadLetter(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      const validation = validateContractSchema(data, contract.responseSchema);
      expect(validation.valid).toBe(true);
      expect(data.record.id).toBe(record.id);
      expect(data.record.resolution).toBe('replayed');
      expect(data.record.resolutionNotes).toBe('Automated retry verification via contract test suite');
    });

    it('POST /api/retry/dead-letters prevents double-resolution (409 Conflict)', async () => {
      const record = deadLetterQueue.record({
        operationClass: 'transaction',
        operationId: 'op_conflict_test',
        reason: 'abandoned',
        classification: classifyError(new Error('Abandoned operation')),
        attempts: [],
        context: {},
      });

      // First resolution: acknowledge
      const firstReq = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          id: record.id,
          outcome: 'acknowledged',
        }),
      });
      const firstRes = await postDeadLetter(firstReq);
      expect(firstRes.status).toBe(200);

      // Duplicate resolution attempt
      const secondReq = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          id: record.id,
          outcome: 'replayed',
        }),
      });
      const secondRes = await postDeadLetter(secondReq);
      expect(secondRes.status).toBe(409);
      const secondData = await secondRes.json();
      expect(secondData.error).toBe('already_resolved');
      expect(secondData.message).toContain('already resolved as "acknowledged"');
    });

    it('POST /api/retry/dead-letters returns 404 for non-existent record ID', async () => {
      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          id: 'non-existent-dead-letter-uuid',
          outcome: 'discarded',
        }),
      });
      const res = await postDeadLetter(req);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('not_found');
    });

    it('POST /api/retry/dead-letters rejects invalid outcome values (400)', async () => {
      const req = new NextRequest('http://localhost:3000/api/retry/dead-letters', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          id: 'some-id',
          outcome: 'invalid_unsupported_outcome',
        }),
      });
      const res = await postDeadLetter(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_outcome');
    });
  });
});
