#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_SEED = 'trellis-rare-path-fixtures-v1';
const MAX_SEED_LENGTH = 128;

function scenarioId(seed, scenario) {
  const digest = createHash('sha256').update(`${seed}:${scenario}`).digest('hex').slice(0, 12);
  return `${scenario}-${digest}`;
}

function makeScenario(seed, scenario, details) {
  const id = scenarioId(seed, scenario);
  return {
    id,
    ...details,
    request: {
      operationId: `fixture-op-${id}`,
      idempotencyKey: `fixture-key-${id}`,
      operation: details.operation,
      authorizationRequired: true,
    },
  };
}

export function generateRarePathFixtures(seed = DEFAULT_SEED) {
  if (typeof seed !== 'string' || seed.trim().length === 0 || seed.length > MAX_SEED_LENGTH) {
    throw new Error(`seed must be a non-empty string of at most ${MAX_SEED_LENGTH} characters`);
  }

  return {
    schemaVersion: 1,
    seed,
    scenarios: [
      makeScenario(seed, 'normal-success', {
        path: 'normal',
        operation: 'submit-transfer',
        attempts: [{ number: 1, httpStatus: 200, outcome: 'success' }],
        expected: {
          outcome: 'success',
          errorCode: null,
          retryCount: 0,
          deadLetter: false,
          sideEffectExecutions: 1,
          authorization: 'authorized',
        },
      }),
      makeScenario(seed, 'validation-failure', {
        path: 'failure',
        operation: 'submit-transfer',
        attempts: [{ number: 1, httpStatus: 422, outcome: 'failure', errorCode: 'VALIDATION_FAILED' }],
        expected: {
          outcome: 'failure',
          errorCode: 'VALIDATION_FAILED',
          retryCount: 0,
          deadLetter: true,
          sideEffectExecutions: 0,
          authorization: 'authorized',
        },
      }),
      makeScenario(seed, 'retry-recovered', {
        path: 'retry',
        operation: 'publish-event',
        attempts: [
          { number: 1, httpStatus: 503, outcome: 'retry', errorCode: 'NETWORK_ERROR' },
          { number: 2, httpStatus: 200, outcome: 'success' },
        ],
        expected: {
          outcome: 'recovered',
          errorCode: null,
          retryCount: 1,
          deadLetter: false,
          sideEffectExecutions: 1,
          authorization: 'authorized',
        },
      }),
      makeScenario(seed, 'retry-exhausted', {
        path: 'retry',
        operation: 'publish-event',
        attempts: [
          { number: 1, httpStatus: 503, outcome: 'retry', errorCode: 'NETWORK_ERROR' },
          { number: 2, httpStatus: 503, outcome: 'retry', errorCode: 'NETWORK_ERROR' },
          { number: 3, httpStatus: 503, outcome: 'retry', errorCode: 'NETWORK_ERROR' },
          { number: 4, httpStatus: 503, outcome: 'failure', errorCode: 'NETWORK_ERROR' },
        ],
        expected: {
          outcome: 'failure',
          errorCode: 'NETWORK_ERROR',
          retryCount: 3,
          deadLetter: true,
          sideEffectExecutions: 0,
          authorization: 'authorized',
        },
      }),
      makeScenario(seed, 'authorization-denied', {
        path: 'authorization',
        operation: 'approve-payout',
        attempts: [{ number: 1, httpStatus: 403, outcome: 'failure', errorCode: 'UNAUTHORIZED' }],
        expected: {
          outcome: 'failure',
          errorCode: 'UNAUTHORIZED',
          retryCount: 0,
          deadLetter: true,
          sideEffectExecutions: 0,
          authorization: 'denied',
        },
      }),
      makeScenario(seed, 'partial-side-effect-recovery', {
        path: 'recovery',
        operation: 'settle-payout',
        attempts: [
          { number: 1, httpStatus: 503, outcome: 'interrupted_after_side_effect', errorCode: 'NETWORK_ERROR' },
          { number: 2, httpStatus: 200, outcome: 'resumed_success' },
        ],
        expected: {
          outcome: 'recovered',
          errorCode: null,
          retryCount: 1,
          deadLetter: false,
          sideEffectExecutions: 1,
          authorization: 'authorized',
        },
      }),
    ],
  };
}

function parseArgs(argv) {
  let seed = DEFAULT_SEED;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') return { help: true };
    if (option !== '--seed') {
      throw new Error(`Unknown option '${option}'. Run with --help for usage.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--seed requires a value');
    seed = value;
    index += 1;
  }
  return { seed };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Generate deterministic synthetic rare-path fixtures.

Usage:
  node scripts/fixtures/generate-rare-path-fixtures.mjs [--seed <value>]

The fixture bundle is written to stdout; no files or services are modified.`);
    return;
  }
  process.stdout.write(`${JSON.stringify(generateRarePathFixtures(options.seed), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
