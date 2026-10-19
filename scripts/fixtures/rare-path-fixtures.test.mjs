import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateRarePathFixtures } from './generate-rare-path-fixtures.mjs';

test('generates deterministic fixtures for normal, failure, retry, and authorization paths', () => {
  const fixtures = generateRarePathFixtures('fixture-test');
  assert.deepEqual(fixtures, generateRarePathFixtures('fixture-test'));
  assert.equal(fixtures.schemaVersion, 1);

  const paths = new Set(fixtures.scenarios.map(({ path }) => path));
  for (const path of ['normal', 'failure', 'retry', 'authorization', 'recovery']) {
    assert.ok(paths.has(path), `missing ${path} path`);
  }
  assert.equal(new Set(fixtures.scenarios.map(({ id }) => id)).size, fixtures.scenarios.length);
  assert.equal(
    new Set(fixtures.scenarios.map(({ request }) => request.idempotencyKey)).size,
    fixtures.scenarios.length,
  );
});

test('makes validation and authorization failures terminal without retrying or writing', () => {
  const { scenarios } = generateRarePathFixtures();
  for (const code of ['VALIDATION_FAILED', 'UNAUTHORIZED']) {
    const scenario = scenarios.find(({ expected }) => expected.errorCode === code);
    assert.ok(scenario, `missing ${code} fixture`);
    assert.equal(scenario.expected.retryCount, 0);
    assert.equal(scenario.expected.deadLetter, true);
    assert.equal(scenario.expected.sideEffectExecutions, 0);
    assert.equal(scenario.attempts.length, 1);
  }
});

test('covers retry recovery and bounded exhaustion with consistent attempt counts', () => {
  const { scenarios } = generateRarePathFixtures();
  for (const scenario of scenarios.filter(({ path }) => path === 'retry')) {
    assert.equal(scenario.attempts.length, scenario.expected.retryCount + 1);
    assert.equal(
      scenario.attempts.filter(({ outcome }) => outcome === 'retry').length,
      scenario.expected.retryCount,
    );
  }
  const recovered = scenarios.find(({ id }) => id.startsWith('retry-recovered'));
  const exhausted = scenarios.find(({ id }) => id.startsWith('retry-exhausted'));
  assert.equal(recovered.expected.outcome, 'recovered');
  assert.equal(recovered.expected.deadLetter, false);
  assert.equal(exhausted.expected.retryCount, 3);
  assert.equal(exhausted.expected.deadLetter, true);
});

test('models recovery after a partial side effect as idempotent and single-execution', () => {
  const scenario = generateRarePathFixtures().scenarios.find(
    ({ path }) => path === 'recovery',
  );
  assert.ok(scenario);
  assert.equal(scenario.attempts[0].outcome, 'interrupted_after_side_effect');
  assert.equal(scenario.attempts[1].outcome, 'resumed_success');
  assert.equal(scenario.expected.sideEffectExecutions, 1);
  assert.equal(scenario.expected.retryCount, 1);
  assert.ok(scenario.request.idempotencyKey);
});

test('rejects invalid seeds and keeps separate seeds isolated', () => {
  assert.throws(() => generateRarePathFixtures(''), /non-empty string/);
  assert.throws(() => generateRarePathFixtures('x'.repeat(129)), /at most 128/);
  assert.notDeepEqual(
    generateRarePathFixtures('seed-a'),
    generateRarePathFixtures('seed-b'),
  );
});
