#!/usr/bin/env node
/**
 * Executable verification suite for the Trellis Developer Diagnostics Command.
 * Runs via Node's built-in test runner (`node --test scripts/verify-diagnostics.mjs`)
 * with zero external runtime dependencies required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  checkTooling,
  checkConfiguration,
  checkDependencies,
  checkConnectivity,
  checkDatabaseAndFixtures,
  checkSystemRequirements,
  checkLocalPorts,
  validateEnvRules,
  parseEnvFileContent,
  getCommonFailureFixes,
  applyAutoFixes,
  runDiagnostics,
} from './diagnostics.mjs';

describe('Developer Diagnostics Executable Verification', () => {
  it('validates Node.js runtime and flags unsupported versions (< 20)', () => {
    const valid = checkTooling({ nodeVersion: 'v20.11.0' });
    const nodePass = valid.find((r) => r.name === 'Node.js Runtime');
    assert.equal(nodePass.status, 'pass');

    const invalid = checkTooling({ nodeVersion: 'v18.19.0' });
    const nodeFail = invalid.find((r) => r.name === 'Node.js Runtime');
    assert.equal(nodeFail.status, 'fail');
    assert.ok(nodeFail.remediation.includes('Upgrade Node.js'));
  });

  it('enforces strict AppConfig security rules without leaking secrets', () => {
    const badProd = validateEnvRules({
      NEXT_PUBLIC_ENVIRONMENT: 'production',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      WEBHOOK_SECRET: 'placeholder-secret',
    });

    assert.equal(badProd.isValid, false);
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_API_URL must use HTTPS in production.'));
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_API_URL cannot point to localhost outside development.'));
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_STELLAR_NETWORK must be mainnet outside development.'));
    assert.ok(
      badProd.problems.includes('WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters.')
    );
    assert.equal(JSON.stringify(badProd).includes('placeholder-secret'), false);

    const invalidPermissionSecret = validateEnvRules({
      NEXT_PUBLIC_ENVIRONMENT: 'development',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      PERMISSION_TOKEN_SECRET: 'placeholder-permission-token-secret-value',
    });
    assert.equal(invalidPermissionSecret.isValid, false);
    assert.ok(invalidPermissionSecret.problems.includes(
      'PERMISSION_TOKEN_SECRET must be a non-placeholder secret of at least 32 characters when set.'
    ));
    assert.equal(JSON.stringify(invalidPermissionSecret).includes('placeholder-permission-token-secret-value'), false);

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'trellis-env-verify-'));
    try {
      const envResults = checkConfiguration({
        rootDir: tmpDir,
        envOverride: {
          NEXT_PUBLIC_ENVIRONMENT: 'development',
          NEXT_PUBLIC_API_URL: 'https://user:private-token@example.test/api?token=private-token',
          NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
        },
      });
      const endpointResult = envResults.find((result) => result.name === 'API Endpoint (NEXT_PUBLIC_API_URL)');
      assert.equal(endpointResult.status, 'pass');
      assert.equal(JSON.stringify(envResults).includes('private-token'), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    const goodDev = validateEnvRules({
      NEXT_PUBLIC_ENVIRONMENT: 'development',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      NEXT_PUBLIC_ENABLE_BETA_FEATURES: 'false',
      PERMISSION_TOKEN_SECRET: 'valid-development-token-secret-with-32-chars',
    });
    assert.equal(goodDev.isValid, true);
  });

  it('detects missing declared project dependencies', () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'trellis-deps-verify-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ dependencies: { present: '1.0.0', missing: '1.0.0' }, devDependencies: { '@scope/tool': '1.0.0' } })
      );
      mkdirSync(join(tmpDir, 'node_modules', 'present'), { recursive: true });
      writeFileSync(join(tmpDir, 'node_modules', 'present', 'package.json'), '{}');

      const results = checkDependencies({ rootDir: tmpDir });
      const declared = results.find((result) => result.name === 'Declared Project Dependencies');
      assert.equal(declared.status, 'fail');
      assert.match(declared.message, /missing/);
      assert.match(declared.message, /@scope\/tool/);
      assert.match(declared.remediation, /npm ci/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates seed data invariants and domain fixture integrity', async () => {
    const results = await checkDatabaseAndFixtures();
    const seedCheck = results.find((r) => r.name === 'Seed Data & Baseline Invariants');
    assert.ok(seedCheck);
    assert.equal(seedCheck.status, 'pass');

    const fixturesCheck = results.find((r) => r.name === 'Domain Invariant Test Fixtures');
    assert.ok(fixturesCheck);
    assert.equal(fixturesCheck.status, 'pass');
  });

  it('verifies external service connectivity probes and fallback warnings', async () => {
    const skipped = await checkConnectivity(true);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].status, 'pass');

    const mockedPass = await checkConnectivity(false, {
      probeFn: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(mockedPass.length, 3);
    assert.ok(mockedPass.every((r) => r.status === 'pass'));

    const mockedWarn = await checkConnectivity(false, {
      probeFn: async () => ({ ok: false, error: 'Connection timed out' }),
      maxAttempts: 1,
    });
    assert.equal(mockedWarn.length, 3);
    assert.ok(mockedWarn.every((r) => r.status === 'warn' && Boolean(r.remediation)));
  });

  it('retries transient network failures with bounded exponential backoff', async () => {
    const attemptsByEndpoint = new Map();
    const delays = [];
    const results = await checkConnectivity(false, {
      maxAttempts: 3,
      retryDelayMs: 10,
      waitFn: async (delay) => delays.push(delay),
      probeFn: async (endpoint) => {
        const attempts = (attemptsByEndpoint.get(endpoint) || 0) + 1;
        attemptsByEndpoint.set(endpoint, attempts);
        return attempts === 1
          ? { ok: false, status: 503, error: 'Service unavailable' }
          : { ok: true, status: 200 };
      },
    });

    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.status === 'pass'));
    assert.deepEqual([...attemptsByEndpoint.values()], [2, 2, 2]);
    assert.deepEqual(delays, [10, 10, 10]);
  });

  it('surfaces authorization denials without retrying or exposing credentials', async () => {
    let attempts = 0;
    const results = await checkConnectivity(false, {
      maxAttempts: 3,
      horizonUrl: 'https://user:private-token@example.test/rpc?token=private-token',
      waitFn: async () => assert.fail('Authorization failures must not be retried'),
      probeFn: async () => {
        attempts++;
        return { ok: false, status: 403, error: 'Forbidden' };
      },
    });

    assert.equal(attempts, 3);
    assert.ok(results.every((result) => result.status === 'warn'));
    assert.ok(results.every((result) => /Authorization was denied/.test(result.message)));
    assert.ok(results.every((result) => /approved local credential provider/.test(result.remediation)));
    assert.equal(JSON.stringify(results).includes('private-token'), false);
  });

  it('stops after the configured number of transient failure attempts', async () => {
    let attempts = 0;
    const results = await checkConnectivity(false, {
      maxAttempts: 2,
      waitFn: async () => {},
      probeFn: async () => {
        attempts++;
        return { ok: false, status: 503, error: 'Service unavailable' };
      },
    });

    assert.equal(attempts, 6);
    assert.ok(results.every((result) => result.status === 'warn'));
  });

  it('applies safe auto-fixes (--fix) and exposes rollback commands', () => {
    const fixes = getCommonFailureFixes();
    assert.ok(fixes.length >= 6);
    for (const fix of fixes) {
      assert.ok(fix.code);
      assert.ok(fix.fixCommand);
      assert.ok(fix.rollbackCommand);
    }

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'trellis-diag-verify-'));
    try {
      writeFileSync(
        join(tmpDir, '.env.example'),
        'NEXT_PUBLIC_API_URL=http://localhost:3001\nNEXT_PUBLIC_ENVIRONMENT=development\nNEXT_PUBLIC_STELLAR_NETWORK=testnet\n'
      );
      const applied = applyAutoFixes({ rootDir: tmpDir });
      assert.equal(applied.length, 1);
      assert.equal(applied[0].code, 'ENV_MISSING_LOCAL');
      assert.equal(existsSync(join(tmpDir, '.env.local')), true);

      const parsed = parseEnvFileContent('NEXT_PUBLIC_ENVIRONMENT="development"\n');
      assert.equal(parsed.NEXT_PUBLIC_ENVIRONMENT, 'development');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('produces a complete, backward-compatible report via runDiagnostics', async () => {
    const report = await runDiagnostics({ skipNetwork: true });
    assert.ok(report.timestamp);
    assert.equal(typeof report.isSuccess, 'boolean');
    assert.equal(report.groups.length, 7);
    assert.ok(Array.isArray(report.commonFailureFixes));
  });
});
