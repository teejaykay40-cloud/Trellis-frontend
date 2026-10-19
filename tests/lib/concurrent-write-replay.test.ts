import {
  resolveEdit,
  type ConflictResolutionResult,
  type ConflictResolutionStore,
  type EditIdentity,
  type EditProposal,
  type JsonObject,
  type VersionedRecord,
} from '@/lib/conflict-resolver';
import { canonicalise } from '@/lib/idempotency';
import {
  DeadLetterQueue,
  InMemoryDeadLetterStore,
  NonRetryableError,
  RetryExhaustedError,
  executeWithRetry,
} from '@/lib/retry';
import {
  DeterministicScheduler,
  ReplayDivergenceError,
  ReplayVersionedStore,
  identityKey,
  scheduleFromTrace,
  storeUnavailable,
  type FaultPlanEntry,
  type ReplayStep,
} from '@/lib/replay';

/**
 * Deterministic replay tests for concurrent writes and retries.
 *
 * Every interleaving below is either scripted (`schedule`) or derived from a
 * seed, so a failure prints a seed and schedule that reproduce it exactly. Set
 * `REPLAY_SEEDS` to widen the sweep locally, e.g. `REPLAY_SEEDS=2000`.
 */

const SEED_COUNT = Number(process.env.REPLAY_SEEDS ?? 50);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const RESOURCE_ID = 'record-1';

const INITIAL_VALUE: JsonObject = {
  title: 'a',
  settings: { theme: 'light', locale: 'en' },
  tags: ['x'],
};

function identity(clientId: string, operationId = 'op-1'): EditIdentity {
  return { actorId: `actor-${clientId}`, clientId, operationId };
}

const INITIAL: VersionedRecord = {
  resourceId: RESOURCE_ID,
  version: 1,
  value: INITIAL_VALUE,
  lastWriter: identity('origin'),
};

function edit(
  clientId: string,
  value: JsonObject,
  base: { version: number; value: JsonObject } = { version: 1, value: INITIAL_VALUE },
): EditProposal {
  return {
    resourceId: RESOURCE_ID,
    baseVersion: base.version,
    baseValue: base.value,
    value,
    identity: identity(clientId),
  };
}

type Policy = (actorId: string, resourceId: string) => boolean;

/** Authorization that yields first, so revocation can be interleaved with writes. */
function gatedAuthorize(scheduler: DeterministicScheduler, taskId: string, policy: Policy) {
  return async (actorId: string, resourceId: string) => {
    await scheduler.checkpoint(taskId, 'authorize');
    return policy(actorId, resourceId);
  };
}

const allowAll: Policy = () => true;

interface RetryHarness {
  scheduler: DeterministicScheduler;
  taskId: string;
  authorize: (actorId: string, resourceId: string) => Promise<boolean>;
  deadLetters: DeadLetterQueue;
  maxRetries?: number;
}

/**
 * The client-side composition under test: `resolveEdit` for the merge and CAS,
 * `executeWithRetry` for transient failures. Uncertain outcomes (storage and
 * authorization outages) are rethrown so the scheduler classifies them; denials
 * and invalid requests are permanent; CAS contention is returned to the caller,
 * which must refresh rather than replay (docs/conflict-resolution.md).
 */
function submitWithRetry(
  proposal: EditProposal,
  store: ConflictResolutionStore,
  harness: RetryHarness,
): Promise<ConflictResolutionResult> {
  return executeWithRetry(
    async () => {
      const result = await resolveEdit(proposal, store, { authorize: harness.authorize });
      switch (result.status) {
        case 'storage_error':
        case 'authorization_error':
          throw result.cause;
        case 'unauthorized':
          throw new NonRetryableError(`Actor ${proposal.identity.actorId} may not edit ${result.resourceId}`);
        case 'invalid_request':
          throw new NonRetryableError(result.reason);
        default:
          return result;
      }
    },
    {
      operationClass: 'http_request',
      operationId: `edit:${proposal.identity.clientId}:${proposal.identity.operationId}`,
      policy: {
        maxRetries: harness.maxRetries ?? 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitter: 'none',
      },
      sleep: harness.scheduler.sleepFor(harness.taskId),
      now: () => 0,
      deadLetterQueue: harness.deadLetters,
    },
  );
}

function newDeadLetters(): DeadLetterQueue {
  return new DeadLetterQueue(new InMemoryDeadLetterStore());
}

function fulfilled<T>(result: PromiseSettledResult<T> | undefined): T {
  if (!result || result.status !== 'fulfilled') {
    throw new Error(`Expected a fulfilled task, got ${result ? String(result.reason) : 'nothing'}`);
  }
  return result.value;
}

function rejected(result: PromiseSettledResult<unknown> | undefined): unknown {
  if (!result || result.status !== 'rejected') {
    throw new Error('Expected a rejected task');
  }
  return result.reason;
}

function labelsFor(trace: readonly ReplayStep[], taskId: string): string[] {
  return trace.filter((step) => step.taskId === taskId).map((step) => step.label);
}

/** Store invariants that must hold after any interleaving. */
function assertStoreInvariants(store: ReplayVersionedStore): void {
  const history = store.history();
  history.forEach((commit, index) => {
    expect(commit.version).toBe(INITIAL.version + index + 1);
  });
  const writers = history.map((commit) => identityKey(commit.writer));
  expect(new Set(writers).size).toBe(writers.length);
  expect(store.snapshot().version).toBe(INITIAL.version + history.length);
}

/* -------------------------------------------------------------------------- */

const THREE_EDITORS = {
  a: edit('a', { ...INITIAL_VALUE, title: 'from-a' }),
  b: edit('b', { ...INITIAL_VALUE, title: 'from-b', settings: { theme: 'dark', locale: 'en' } }),
  c: edit('c', { ...INITIAL_VALUE, tags: ['x', 'y'], settings: { theme: 'light', locale: 'fr' } }),
};

const THREE_EDITORS_MERGED: JsonObject = {
  title: 'from-b',
  settings: { theme: 'dark', locale: 'fr' },
  tags: ['x', 'y'],
};

async function runThreeEditors(scheduler: DeterministicScheduler) {
  const store = new ReplayVersionedStore(INITIAL, { scheduler });
  const run = await scheduler.run(
    Object.fromEntries(
      Object.entries(THREE_EDITORS).map(([taskId, proposal]) => [
        taskId,
        () =>
          resolveEdit(proposal, store.forTask(taskId), {
            authorize: gatedAuthorize(scheduler, taskId, allowAll),
          }),
      ]),
    ),
  );
  return { store, ...run };
}

describe('deterministic replay scheduler', () => {
  it('produces the same trace and outcome for the same seed', async () => {
    const first = await runThreeEditors(new DeterministicScheduler({ seed: 42 }));
    const second = await runThreeEditors(new DeterministicScheduler({ seed: 42 }));

    expect(second.trace).toEqual(first.trace);
    expect(second.results).toEqual(first.results);
    expect(second.store.history()).toEqual(first.store.history());
  });

  it('replays a recorded trace step for step', async () => {
    const recorded = await runThreeEditors(new DeterministicScheduler({ seed: 7 }));
    const replayed = await runThreeEditors(
      new DeterministicScheduler({ seed: 999, schedule: scheduleFromTrace(recorded.trace) }),
    );

    expect(replayed.trace).toEqual(recorded.trace);
    expect(replayed.store.history()).toEqual(recorded.store.history());
  });

  it('explores different interleavings across seeds', async () => {
    const traces = new Set<string>();
    for (const seed of SEEDS.slice(0, 20)) {
      const { trace } = await runThreeEditors(new DeterministicScheduler({ seed }));
      traces.add(scheduleFromTrace(trace).join(''));
    }
    expect(traces.size).toBeGreaterThan(1);
  });

  it('fails loudly when a scripted schedule no longer matches the code', async () => {
    await expect(
      runThreeEditors(new DeterministicScheduler({ schedule: ['a', 'a', 'a', 'a', 'a'] })),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it('is a pass-through outside a run', async () => {
    const scheduler = new DeterministicScheduler();
    await expect(scheduler.checkpoint('solo', 'read')).resolves.toBeUndefined();
  });
});

describe('concurrent writes: normal path', () => {
  it('converges to one merged document under every seeded interleaving', async () => {
    const failures: string[] = [];

    for (const seed of SEEDS) {
      const { store, results, trace } = await runThreeEditors(new DeterministicScheduler({ seed }));
      const outcomes = Object.values(results).map((result) => fulfilled(result));
      const replay = `seed=${seed} schedule=${JSON.stringify(scheduleFromTrace(trace))}`;

      if (!outcomes.every((outcome) => outcome.status === 'applied')) {
        failures.push(`${replay}: not all applied ${JSON.stringify(outcomes)}`);
      }
      if (canonicalise(store.snapshot().value) !== canonicalise(THREE_EDITORS_MERGED)) {
        failures.push(`${replay}: diverged to ${JSON.stringify(store.snapshot().value)}`);
      }
      assertStoreInvariants(store);
      expect(store.history()).toHaveLength(3);
    }

    expect(failures).toEqual([]);
  });

  it('stays within the default CAS budget with three contenders', async () => {
    for (const seed of SEEDS) {
      const { results } = await runThreeEditors(new DeterministicScheduler({ seed }));
      for (const result of Object.values(results)) {
        const outcome = fulfilled(result);
        // Each contender can lose at most one CAS per other contender's commit.
        expect(outcome).toMatchObject({ status: 'applied' });
        if (outcome.status === 'applied') expect(outcome.attempts).toBeLessThanOrEqual(3);
      }
    }
  });

  it('commits a concurrent double submit exactly once', async () => {
    const proposal = edit('a', { ...INITIAL_VALUE, title: 'once' });

    for (const seed of SEEDS) {
      const scheduler = new DeterministicScheduler({ seed });
      const store = new ReplayVersionedStore(INITIAL, { scheduler });
      const { results } = await scheduler.run({
        click1: () =>
          resolveEdit(proposal, store.forTask('click1'), {
            authorize: gatedAuthorize(scheduler, 'click1', allowAll),
          }),
        click2: () =>
          resolveEdit(proposal, store.forTask('click2'), {
            authorize: gatedAuthorize(scheduler, 'click2', allowAll),
          }),
      });

      const statuses = [fulfilled(results.click1).status, fulfilled(results.click2).status].sort();
      expect(statuses).toEqual(['already_applied', 'applied']);
      expect(store.history()).toHaveLength(1);
    }
  });
});

describe('concurrent writes: failure and retry paths', () => {
  it('recognises a retried write whose CAS response was lost', async () => {
    const scheduler = new DeterministicScheduler({ seed: 1 });
    const store = new ReplayVersionedStore(INITIAL, {
      scheduler,
      faults: [{ taskId: 'a', operation: 'compareAndSwap', occurrence: 1, kind: 'lost_response' }],
    });
    const deadLetters = newDeadLetters();

    const { results, trace } = await scheduler.run({
      a: () =>
        submitWithRetry(edit('a', { ...INITIAL_VALUE, title: 'b' }), store.forTask('a'), {
          scheduler,
          taskId: 'a',
          authorize: gatedAuthorize(scheduler, 'a', allowAll),
          deadLetters,
        }),
    });

    expect(fulfilled(results.a)).toEqual({ status: 'already_applied', version: 2 });
    expect(labelsFor(trace, 'a')).toEqual([
      'authorize',
      'read',
      'compareAndSwap',
      'backoff:10',
      'authorize',
      'read',
    ]);
    expect(store.history()).toHaveLength(1);
    expect(deadLetters.list()).toHaveLength(0);
  });

  describe('lost response followed by a newer write from another client', () => {
    // a's CAS commits "b" but a never hears back. Before a retries, b reads
    // version 2 and deliberately changes the title to "aa". a's retry must not
    // undo b's edit.
    const SCHEDULE = ['a', 'a', 'a', 'a', 'b', 'b', 'b'];
    const lostResponse: FaultPlanEntry[] = [
      { taskId: 'a', operation: 'compareAndSwap', occurrence: 1, kind: 'lost_response' },
    ];
    const afterA = { version: 2, value: { ...INITIAL_VALUE, title: 'b' } };

    async function run(trackAppliedOperations: boolean) {
      const scheduler = new DeterministicScheduler({ schedule: SCHEDULE });
      const store = new ReplayVersionedStore(INITIAL, {
        scheduler,
        faults: lostResponse,
        trackAppliedOperations,
      });
      const deadLetters = newDeadLetters();
      const run = await scheduler.run({
        a: () =>
          submitWithRetry(edit('a', { ...INITIAL_VALUE, title: 'b' }), store.forTask('a'), {
            scheduler,
            taskId: 'a',
            authorize: gatedAuthorize(scheduler, 'a', allowAll),
            deadLetters,
          }),
        b: () =>
          resolveEdit(edit('b', { ...INITIAL_VALUE, title: 'aa' }, afterA), store.forTask('b'), {
            authorize: gatedAuthorize(scheduler, 'b', allowAll),
          }),
      });
      return { store, ...run };
    }

    it('resurrects the stale value when the store only knows its latest writer', async () => {
      // Documents the hazard the optional `findAppliedVersion` hook closes.
      const { store, results } = await run(false);

      expect(fulfilled(results.b)).toMatchObject({ status: 'applied', version: 3 });
      expect(fulfilled(results.a)).toMatchObject({ status: 'applied', version: 4, conflictPaths: ['/title'] });
      expect(store.snapshot().value.title).toBe('b');
      expect(store.history().map((commit) => commit.writer.clientId)).toEqual(['a', 'b', 'a']);
    });

    it('reports already_applied and keeps the newer write when the store tracks applied operations', async () => {
      const { store, results, trace } = await run(true);

      expect(fulfilled(results.b)).toMatchObject({ status: 'applied', version: 3 });
      expect(fulfilled(results.a)).toEqual({ status: 'already_applied', version: 2 });
      expect(store.snapshot().value.title).toBe('aa');
      expect(store.history().map((commit) => commit.writer.clientId)).toEqual(['a', 'b']);
      expect(labelsFor(trace, 'a').slice(-1)).toEqual(['findAppliedVersion']);
      assertStoreInvariants(store);
    });
  });

  it('never applies a write twice under any interleaving of lost responses and retries', async () => {
    const failures: string[] = [];

    for (const seed of SEEDS) {
      const scheduler = new DeterministicScheduler({ seed });
      const store = new ReplayVersionedStore(INITIAL, {
        scheduler,
        trackAppliedOperations: true,
        faults: [
          { taskId: 'a', operation: 'compareAndSwap', occurrence: 1, kind: 'lost_response' },
          { taskId: 'b', operation: 'read', occurrence: 1, kind: 'unavailable' },
        ],
      });
      const deadLetters = newDeadLetters();
      const { results, trace } = await scheduler.run(
        Object.fromEntries(
          Object.entries(THREE_EDITORS).map(([taskId, proposal]) => [
            taskId,
            () =>
              submitWithRetry(proposal, store.forTask(taskId), {
                scheduler,
                taskId,
                authorize: gatedAuthorize(scheduler, taskId, allowAll),
                deadLetters,
              }),
          ]),
        ),
      );

      const replay = `seed=${seed} schedule=${JSON.stringify(scheduleFromTrace(trace))}`;
      const statuses = Object.values(results).map((result) => fulfilled(result).status);
      if (statuses.some((status) => status !== 'applied' && status !== 'already_applied')) {
        failures.push(`${replay}: unexpected ${JSON.stringify(statuses)}`);
      }
      if (store.history().length !== 3) {
        failures.push(`${replay}: ${store.history().length} commits`);
      }
      if (canonicalise(store.snapshot().value) !== canonicalise(THREE_EDITORS_MERGED)) {
        failures.push(`${replay}: diverged to ${JSON.stringify(store.snapshot().value)}`);
      }
      assertStoreInvariants(store);
      expect(deadLetters.list()).toHaveLength(0);
    }

    expect(failures).toEqual([]);
  });

  it('retries a transient read outage and then applies', async () => {
    const scheduler = new DeterministicScheduler({ seed: 3 });
    const store = new ReplayVersionedStore(INITIAL, {
      scheduler,
      faults: [{ taskId: 'a', operation: 'read', occurrence: 1, kind: 'unavailable' }],
    });
    const deadLetters = newDeadLetters();

    const { results } = await scheduler.run({
      a: () =>
        submitWithRetry(edit('a', { ...INITIAL_VALUE, title: 'b' }), store.forTask('a'), {
          scheduler,
          taskId: 'a',
          authorize: gatedAuthorize(scheduler, 'a', allowAll),
          deadLetters,
        }),
    });

    expect(fulfilled(results.a)).toMatchObject({ status: 'applied', version: 2 });
    expect(deadLetters.list()).toHaveLength(0);
  });

  it('dead-letters a persistent outage without leaving a partial write', async () => {
    const scheduler = new DeterministicScheduler({ seed: 3 });
    const store = new ReplayVersionedStore(INITIAL, {
      scheduler,
      faults: [{ taskId: 'a', operation: 'compareAndSwap', kind: 'unavailable' }],
    });
    const deadLetters = newDeadLetters();

    const { results, trace } = await scheduler.run({
      a: () =>
        submitWithRetry(edit('a', { ...INITIAL_VALUE, title: 'b' }), store.forTask('a'), {
          scheduler,
          taskId: 'a',
          authorize: gatedAuthorize(scheduler, 'a', allowAll),
          deadLetters,
          maxRetries: 2,
        }),
    });

    const error = rejected(results.a);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect((error as RetryExhaustedError).attempts).toBe(3);
    expect(labelsFor(trace, 'a').filter((label) => label.startsWith('backoff'))).toEqual([
      'backoff:10',
      'backoff:20',
    ]);

    const [record] = deadLetters.list();
    expect(record).toMatchObject({ reason: 'retries_exhausted', attemptsCount: 3 });
    expect(record.classification).toMatchObject({ retryable: true, status: 503 });

    expect(store.snapshot()).toEqual(INITIAL);
    expect(store.history()).toEqual([]);
  });

  it('returns CAS contention to the caller, who recovers by refreshing', async () => {
    const scheduler = new DeterministicScheduler({ schedule: ['a', 'a', 'b', 'b', 'b', 'a'] });
    const store = new ReplayVersionedStore(INITIAL, { scheduler });
    const proposalA = edit('a', { ...INITIAL_VALUE, title: 'from-a' });

    const { results } = await scheduler.run({
      a: () =>
        resolveEdit(proposalA, store.forTask('a'), {
          authorize: gatedAuthorize(scheduler, 'a', allowAll),
          maxAttempts: 1,
        }),
      b: () =>
        resolveEdit(THREE_EDITORS.b, store.forTask('b'), {
          authorize: gatedAuthorize(scheduler, 'b', allowAll),
        }),
    });

    expect(fulfilled(results.a)).toEqual({ status: 'retry_exhausted', attempts: 1 });
    expect(store.history().map((commit) => commit.writer.clientId)).toEqual(['b']);

    // Recovery: refresh, rebase the user's change on the new snapshot, and
    // submit it as a new operation.
    const fresh = store.snapshot();
    const rebased: EditProposal = {
      ...edit('a', { ...fresh.value, title: 'from-a' }, fresh),
      identity: identity('a', 'op-2'),
    };
    await expect(
      resolveEdit(rebased, store.forTask('a'), { authorize: allowAll }),
    ).resolves.toMatchObject({ status: 'applied', version: 3 });
    expect(store.snapshot().value.title).toBe('from-a');
  });
});

describe('concurrent writes: authorization path', () => {
  it('denies an unauthorized writer without reading, retrying, or writing under every interleaving', async () => {
    const onlyA: Policy = (actorId) => actorId === 'actor-a';

    for (const seed of SEEDS) {
      const scheduler = new DeterministicScheduler({ seed });
      const store = new ReplayVersionedStore(INITIAL, { scheduler });
      const deadLetters = newDeadLetters();
      const harness = (taskId: string): RetryHarness => ({
        scheduler,
        taskId,
        authorize: gatedAuthorize(scheduler, taskId, onlyA),
        deadLetters,
      });

      const { results, trace } = await scheduler.run({
        a: () => submitWithRetry(THREE_EDITORS.a, store.forTask('a'), harness('a')),
        intruder: () =>
          submitWithRetry(edit('intruder', { ...INITIAL_VALUE, title: 'zzz' }), store.forTask('intruder'), harness('intruder')),
      });

      expect(fulfilled(results.a)).toMatchObject({ status: 'applied' });
      expect(rejected(results.intruder)).toBeInstanceOf(RetryExhaustedError);
      expect(labelsFor(trace, 'intruder')).toEqual(['authorize']);
      expect(deadLetters.list()).toEqual([
        expect.objectContaining({ reason: 'non_retryable', attemptsCount: 1, operationId: 'edit:intruder:op-1' }),
      ]);
      expect(store.history().map((commit) => commit.writer.clientId)).toEqual(['a']);
    }
  });

  it('re-checks authorization on a CAS retry, so a revocation mid-write wins', async () => {
    const granted = new Set(['actor-a', 'actor-b']);
    const policy: Policy = (actorId) => granted.has(actorId);
    const scheduler = new DeterministicScheduler({
      // a reads v1; b commits v2; access is revoked; a's CAS fails; a re-authorizes.
      schedule: ['a', 'a', 'b', 'b', 'b', 'revoker', 'a', 'a'],
    });
    const store = new ReplayVersionedStore(INITIAL, { scheduler });

    const { results, trace } = await scheduler.run<unknown>({
      a: () =>
        resolveEdit(THREE_EDITORS.a, store.forTask('a'), {
          authorize: gatedAuthorize(scheduler, 'a', policy),
        }),
      b: () =>
        resolveEdit(THREE_EDITORS.b, store.forTask('b'), {
          authorize: gatedAuthorize(scheduler, 'b', policy),
        }),
      revoker: async () => {
        await scheduler.checkpoint('revoker', 'revoke');
        granted.delete('actor-a');
      },
    });

    expect(fulfilled(results.a)).toEqual({ status: 'unauthorized', resourceId: RESOURCE_ID });
    expect(labelsFor(trace, 'a')).toEqual(['authorize', 'read', 'compareAndSwap', 'authorize']);
    expect(store.history().map((commit) => commit.writer.clientId)).toEqual(['b']);
  });

  it('retries an authorization service outage, then applies', async () => {
    const scheduler = new DeterministicScheduler({ seed: 5 });
    const store = new ReplayVersionedStore(INITIAL, { scheduler });
    const deadLetters = newDeadLetters();
    let calls = 0;
    const flaky = async (actorId: string, resourceId: string) => {
      await scheduler.checkpoint('a', 'authorize');
      calls += 1;
      if (calls === 1) throw storeUnavailable('read');
      return allowAll(actorId, resourceId);
    };

    const { results } = await scheduler.run({
      a: () =>
        submitWithRetry(THREE_EDITORS.a, store.forTask('a'), {
          scheduler,
          taskId: 'a',
          authorize: flaky,
          deadLetters,
        }),
    });

    expect(fulfilled(results.a)).toMatchObject({ status: 'applied', version: 2 });
    expect(calls).toBe(2);
    expect(deadLetters.list()).toHaveLength(0);
  });

  it('fails closed when the authorization service stays down', async () => {
    const scheduler = new DeterministicScheduler({ seed: 5 });
    const store = new ReplayVersionedStore(INITIAL, { scheduler });
    const deadLetters = newDeadLetters();
    const down = async () => {
      await scheduler.checkpoint('a', 'authorize');
      throw storeUnavailable('read');
    };

    const { results, trace } = await scheduler.run({
      a: () =>
        submitWithRetry(THREE_EDITORS.a, store.forTask('a'), {
          scheduler,
          taskId: 'a',
          authorize: down,
          deadLetters,
          maxRetries: 1,
        }),
    });

    expect(rejected(results.a)).toBeInstanceOf(RetryExhaustedError);
    expect(labelsFor(trace, 'a')).not.toContain('read');
    expect(deadLetters.list()).toEqual([expect.objectContaining({ reason: 'retries_exhausted' })]);
    expect(store.history()).toEqual([]);
  });
});
