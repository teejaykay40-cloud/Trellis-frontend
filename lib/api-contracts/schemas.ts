import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export interface ApiContractDefinition {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
  authRequired: boolean;
  queryParams?: Record<string, { type: string; required: boolean; description: string }>;
  requestSchema?: z.ZodTypeAny;
  responseSchema: z.ZodTypeAny;
  errorResponses: Record<number, { code: string; message: string }>;
}

export const API_CONTRACTS: Record<string, ApiContractDefinition> = {
  'GET /api/affiliates': {
    path: '/api/affiliates',
    method: 'GET',
    description: 'Lists all available affiliate endpoints and documentation overview',
    authRequired: false,
    responseSchema: z.object({
      message: z.string(),
      endpoints: z.record(z.string(), z.string()),
    }).openapi('AffiliatesResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'GET /api/affiliates/program': {
    path: '/api/affiliates/program',
    method: 'GET',
    description: 'Fetches affiliate program tier rules and commission structures',
    authRequired: false,
    responseSchema: z.union([
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        commissionStructure: z.record(z.string(), z.number()),
        minimumPayout: z.string(),
        payoutFrequency: z.string(),
        guidelines: z.array(z.string()),
        joinedAt: z.string().optional(),
      }),
      z.object({
        tiers: z.array(z.any()),
        cookieDurationDays: z.number(),
      }),
    ]).openapi('AffiliatesProgramResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'GET /api/metrics/panels': {
    path: '/api/metrics/panels',
    method: 'GET',
    description: 'Lists all available metrics monitoring panels',
    authRequired: false,
    responseSchema: z.object({
      source: z.string(),
      panels: z.array(z.any()),
    }).openapi('MetricsPanelsResponse'),
    errorResponses: {
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'POST /api/import/dry-run': {
    path: '/api/import/dry-run',
    method: 'POST',
    description: 'Validates bulk import datasets without persistent writes',
    authRequired: false,
    queryParams: {
      entityType: { type: 'string', required: false, description: 'Target entity type' },
    },
    responseSchema: z.object({
      success: z.boolean(),
      dryRun: z.boolean(),
      entityType: z.string(),
      summary: z.object({
        totalRows: z.number(),
        validRows: z.number(),
        invalidRows: z.number(),
        createCount: z.number(),
        updateCount: z.number(),
        skipCount: z.number(),
        errorCount: z.number(),
        duplicateCount: z.number(),
      }).partial(),
      rows: z.array(z.any()),
    }).openapi('DryRunResponse'),
    errorResponses: {
      422: { code: 'VALIDATION_FAILED', message: 'Input rows failed validation rules' },
      500: { code: 'INTERNAL_ERROR', message: 'Dry run processing error' },
    },
  },
  'GET /api/bug-reports': {
    path: '/api/bug-reports',
    method: 'GET',
    description: 'Lists bug reports with cursor-based pagination and status filtering',
    authRequired: false,
    queryParams: {
      status: { type: 'string', required: false, description: 'Filter by bug report status (submitted, triaged, in_progress, resolved, rejected, all)' },
      limit: { type: 'number', required: false, description: 'Page size limit' },
      cursor: { type: 'string', required: false, description: 'Opaque base64 cursor timestamp and id' },
    },
    responseSchema: z.object({
      bugReports: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          priority: z.string(),
          category: z.string(),
        }).passthrough(),
      ),
      total: z.number(),
      nextCursor: z.string().nullable().optional(),
      hasMore: z.boolean().optional(),
    }).openapi('BugReportsPaginatedResponse'),
    errorResponses: {
      400: { code: 'INVALID_QUERY', message: 'Invalid query parameters' },
      500: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    },
  },
  'GET /api/retry/dead-letters': {
    path: '/api/retry/dead-letters',
    method: 'GET',
    description: 'Lists dead-letter queue records with authorization, filtering, and pagination limits',
    authRequired: true,
    queryParams: {
      reason: { type: 'string', required: false, description: 'Filter by failure reason (retries_exhausted, non_retryable, abandoned)' },
      operationClass: { type: 'string', required: false, description: 'Filter by operation class' },
      includeResolved: { type: 'boolean', required: false, description: 'Include resolved dead letter records' },
      limit: { type: 'number', required: false, description: 'Bounded integer limit between 1 and 200' },
    },
    responseSchema: z.object({
      records: z.array(
        z.object({
          id: z.string(),
          operationClass: z.string(),
          reason: z.string(),
          deadLetteredAt: z.string(),
          attemptsCount: z.number().optional(),
        }).passthrough(),
      ),
      stats: z.object({
        total: z.number(),
        dropped: z.number(),
      }).passthrough(),
      droppedCount: z.number(),
    }).openapi('DeadLettersListResponse'),
    errorResponses: {
      400: { code: 'INVALID_PARAM', message: 'Invalid query parameter provided' },
      401: { code: 'UNAUTHORIZED', message: 'Bearer token authorization required' },
      503: { code: 'NOT_CONFIGURED', message: 'Authorization secret is unconfigured (fail-closed)' },
    },
  },
  'POST /api/retry/dead-letters': {
    path: '/api/retry/dead-letters',
    method: 'POST',
    description: 'Resolves or retries a dead-lettered operational record',
    authRequired: true,
    requestSchema: z.object({
      id: z.string().min(1),
      outcome: z.enum(['replayed', 'discarded', 'acknowledged']),
      notes: z.string().max(2000).optional(),
    }).openapi('DeadLetterResolveRequest'),
    responseSchema: z.object({
      record: z.object({
        id: z.string(),
        resolution: z.string(),
        resolvedAt: z.string(),
      }).passthrough(),
    }).openapi('DeadLetterResolveResponse'),
    errorResponses: {
      400: { code: 'INVALID_REQUEST', message: 'Invalid request body or outcome' },
      401: { code: 'UNAUTHORIZED', message: 'Bearer token authorization required' },
      404: { code: 'NOT_FOUND', message: 'Dead letter record not found' },
      409: { code: 'ALREADY_RESOLVED', message: 'Record was already resolved' },
      503: { code: 'NOT_CONFIGURED', message: 'Authorization secret unconfigured' },
    },
  },
  'POST /api/export': {
    path: '/api/export',
    method: 'POST',
    description: 'Scoped data export with authorization boundaries, type filtering, and retention windows',
    authRequired: true,
    requestSchema: z.object({
      wallet: z.string().min(56).max(56),
      type: z.enum(['simulations', 'analytics', 'telemetry', 'affiliates']),
      from: z.string().optional(),
      to: z.string().optional(),
      format: z.enum(['json', 'csv']).optional(),
    }).openapi('ExportRequest'),
    responseSchema: z.object({
      exportId: z.string(),
      schemaVersion: z.string(),
      type: z.string(),
      wallet: z.string(),
      recordCount: z.number(),
      data: z.array(z.any()),
    }).openapi('ExportResponse'),
    errorResponses: {
      400: { code: 'INVALID_REQUEST', message: 'Invalid date range or format' },
      401: { code: 'UNAUTHORIZED', message: 'Missing or invalid authentication token' },
      403: { code: 'FORBIDDEN', message: 'Actor role lacks export capability' },
    },
  },
};

/**
 * Validate that an object adheres to a contract schema specification.
 * Returns true if valid, or an array of error messages.
 */
export function validateContractSchema(data: any, schema: z.ZodTypeAny): { valid: boolean; errors: string[] } {
  const result = schema.safeParse(data);
  return {
    valid: result.success,
    errors: result.success ? [] : result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
  };
}
