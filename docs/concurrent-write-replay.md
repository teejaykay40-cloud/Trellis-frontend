# Deterministic replay tests for concurrent writes and retries

`lib/replay/` is a test harness for making write races reproducible. It
drives `lib/conflict-resolver.ts` (three-way merge + compare-and-swap) and
`lib/retry` (bounded backoff + dead-letter queue) through controlled
interleavings, with scripted faults. The suite lives in
`tests/lib/concurrent-write-replay.test.ts`.

```bash
npm run test:replay                    # default sweep: 50 seeds per property
REPLAY_SEEDS=2000 npm run test:replay  # wider sweep before touching the resolver
```

## How it works

- **`DeterministicScheduler`** runs each task until it reaches a
  `checkpoint(taskId, label)`. Once every task is blocked or finished, it
  releases exactly one waiting task. The next task comes from an explicit
  `schedule` if one is given, or from a seeded PRNG otherwise. Each release is
  recorded in a trace (`{ index, taskId, label }`).
- **`ReplayVersionedStore`** is an in-memory `ConflictResolutionStore` with
  atomic CAS, a commit history and an applied-operation log. Each call made
  through `store.forTask(id)` checkpoints first, so other tasks can run in the
  gap between a read and its CAS.
- **Fault plans** are data, not randomness:
  `{ taskId, operation, occurrence?, kind }`. `unavailable` fails before
  touching state. `lost_response` applies the change and then throws a 503.
  That second case is the uncertain outcome that makes retries risky.
- **Backoff is a checkpoint.** `scheduler.sleepFor(taskId)` is passed to
  `executeWithRetry` as `sleep`, so other clients can be scheduled to write
  while a retry is waiting. Tests run instantly, with no real timers.

### Reproducing a failure

Every seed sweep prints `seed=<n> schedule=[...]` for each failing run. To
replay that interleaving step for step, use either of these:

```ts
new DeterministicScheduler({ seed: n });
new DeterministicScheduler({ schedule: ['a', 'b', 'a', ...] });
```

If a code change adds or removes a checkpoint, a scripted schedule stops
matching. The run then fails with `ReplayDivergenceError`, naming the step and
the tasks that were waiting. It never quietly replays a different
interleaving. When that happens, re-record the schedule from the new trace
(`scheduleFromTrace`).

## What is covered

| Path | Scenario | Expected |
|---|---|---|
| Normal | 3 concurrent editors (disjoint and conflicting fields), every seed | All `applied`; identical final document; versions contiguous; ≤ 3 CAS attempts each |
| Normal | Concurrent double submit of one operation | Exactly one commit, one `already_applied` |
| Retry | CAS commits, response lost, client retries | `already_applied`, single commit |
| Retry | Lost response **and** another client writes before the retry | See the edge case below |
| Retry | Lost responses + read outages across 3 editors, every seed | No operation committed twice; same final document |
| Retry | Transient read outage | Retried, then `applied`; no dead letter |
| Failure | Persistent CAS outage | `RetryExhaustedError`; dead letter `retries_exhausted` with attempt history; store untouched |
| Failure | CAS contention past `maxAttempts` | `retry_exhausted` returned (not thrown); refresh-and-resubmit recovers |
| Authz | Unauthorized writer racing an authorized one, every seed | Never reads, never retries, never writes; dead letter `non_retryable` |
| Authz | Access revoked between a failed CAS and its retry | `unauthorized`; nothing written |
| Authz | Authorization service outage, transient / persistent | Retried then `applied` / fails closed, never reads the record |

## Operational edge cases

### Lost response + intervening write can resurrect stale data

Here is the sequence. Client A's CAS commits `title: "b"`, but A never gets
the response. Client B then reads version 2 and deliberately changes the title
to `"aa"`. A retries the same operation. A is no longer the record's
`lastWriter`, so the resolver merges again from A's original base. Both sides
changed `/title`, which is a conflict, and the greater value `"b"` wins. B's
newer edit is silently reverted and A is committed twice.

The fix is a new **optional** store method,
`findAppliedVersion(resourceId, identity)`. When a store implements it, the
resolver checks it after authorization and before merging, and returns
`already_applied` with the version the operation was committed at.
**Production stores that can see operation identities should implement it**,
for example from an `applied_operations` table or the audit log. The test
"resurrects the stale value when the store only knows its latest writer" pins
the old behaviour so the hazard stays documented. A failure inside
`findAppliedVersion` is reported as `storage_error` with phase `read`, and
nothing is written.

### Other behaviour operators should know

- **Authorization is re-checked on every CAS attempt.** Revoking access takes
  effect on the writer's next attempt, even partway through a write. Denials
  are permanent (`NonRetryableError`). They are not retried and they don't use
  up the retry budget.
- **Authorization outages fail closed.** The record is never read while the
  authorizer is down. Once the retry budget runs out, the write is
  dead-lettered as `retries_exhausted`.
- **CAS contention is not a transport failure.** `retry_exhausted` comes back
  to the caller instead of being retried by `executeWithRetry`, because
  replaying a stale base harder does not help. The caller should refresh,
  rebase the user's change, and submit it under a **new** `operationId`.
- **Operation identities must be unique per intent.** Reusing an
  `operationId` for a different edit makes the second edit look like a replay
  of the first, and it gets reported as `already_applied`.

## Recovery and rollback

- **Dead-lettered writes** (`retries_exhausted`) never leave a partial state.
  Either the CAS committed, or the store is unchanged. The suite asserts this.
  Before replaying a dead-lettered write, re-submit it with the **same**
  identity so a commit that did land is recognised. That check is only
  reliable on stores that implement `findAppliedVersion`.
- **Rolling back this change.** The only production change is the optional
  `findAppliedVersion` hook in `lib/conflict-resolver.ts`. Existing stores do
  not implement it, so their behaviour is unchanged. Reverting the commit is
  safe and needs no data migration. `lib/replay/` is test-only and nothing in
  `app/` imports it.

## Contract and migration

- `ConflictResolutionStore` only gains an optional method.
  `ConflictResolutionResult` is unchanged: hook failures reuse
  `storage_error`/`read`, so exhaustive `switch`es keep compiling.
- To adopt the hook, record `(resourceId, actorId, clientId, operationId) →
  version` in the same transaction as the CAS, then expose the lookup. Keep
  entries for at least the client's retry window. The default
  `transaction` policy can retry for several minutes, and dead-letter replays
  can come much later.
