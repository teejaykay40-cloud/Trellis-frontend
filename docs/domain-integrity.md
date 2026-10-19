# Domain Integrity Framework

This document covers four interconnected systems introduced to address issues
[#53][i53], [#54][i54], [#55][i55], and [#56][i56].  They work together to
make the Trellis frontend resilient to interrupted operations, tampered data,
impossible domain states, and failed schema migrations.

It also defines the cross-service contract map for domain events and integration boundaries — see [Section 7](#7-cross-service-contract-map-domain-events--integration-boundaries).

[i53]: https://github.com/TRELLIS-STELLAR/Trellis-frontend/issues/53
[i54]: https://github.com/TRELLIS-STELLAR/Trellis-frontend/issues/54
[i55]: https://github.com/TRELLIS-STELLAR/Trellis-frontend/issues/55
[i56]: https://github.com/TRELLIS-STELLAR/Trellis-frontend/issues/56

---

## Table of Contents

1. [Recovery Flow (Issue #54)](#1-recovery-flow-issue-54)
2. [Tamper-Evident Change History (Issue #53)](#2-tamper-evident-change-history-issue-53)
3. [Domain Invariant Test Suite (Issue #55)](#3-domain-invariant-test-suite-issue-55)
4. [Migration Safety Framework (Issue #56)](#4-migration-safety-framework-issue-56)
5. [Running the Tests](#5-running-the-tests)
6. [Design Decisions and Tradeoffs](#6-design-decisions-and-tradeoffs)
7. [Cross-Service Contract Map (Domain Events & Integration Boundaries)](#7-cross-service-contract-map-domain-events--integration-boundaries)

---

## 1. Recovery Flow (Issue #54)

**Location:** `lib/recovery/`

### Problem

Multi-step operations (agent minting, staking, delegation, import pipelines)
can be interrupted at any point — the wallet popup is dismissed, the browser
tab is closed, a network request times out.  Without recovery, either the user
is stuck with a partially-applied state, or retrying the entire flow risks
duplicate side effects (double signing, double API writes).

### Solution: Checkpoint-based state machine

Every multi-step operation is registered with an `OperationManager` before any
step executes.  Each step is marked `sideEffect: true` if it interacts with an
external system (Stellar chain, API, worker).  After a side-effect step
succeeds, a **checkpoint** is written immediately.

On resume, the engine skips any step whose checkpoint already exists.
Non-side-effect steps (pure computation) always re-run — they are cheap and
safe to repeat.

```
Step 1 (build tx)     — sideEffect: false → re-run on resume
Step 2 (sign tx)      — sideEffect: true  → checkpoint written after success
Step 3 (submit tx)    — sideEffect: true  → checkpoint written after success
Step 4 (notify user)  — sideEffect: false → re-run on resume
```

### Key files

| File | Purpose |
|---|---|
| `lib/recovery/types.ts` | All type definitions (OperationStep, RecoverableOperation, CheckpointStore, etc.) |
| `lib/recovery/checkpoint-store.ts` | `MemoryCheckpointStore` (tests/SSR) and `LocalStorageCheckpointStore` (browser sessions) |
| `lib/recovery/operation-manager.ts` | `OperationManager` — create, execute, resume, diagnose |

### Usage

```typescript
import { OperationManager } from '@/lib/recovery/operation-manager';
import { MemoryCheckpointStore } from '@/lib/recovery/checkpoint-store';

const manager = new OperationManager();

// 1. Register the operation before starting
const op = manager.create('agent_mint', 'Mint Agent: My Bot', [
  { id: 'build',  label: 'Build transaction', sideEffect: false },
  { id: 'sign',   label: 'Sign with wallet',  sideEffect: true  },
  { id: 'submit', label: 'Submit to network', sideEffect: true  },
]);

// 2. Execute (or resume by passing the same op.id back)
const result = await manager.execute(op.id, async (step, context, prevOutputs) => {
  if (step.id === 'build')  return buildTx(context);
  if (step.id === 'sign')   return signTx(prevOutputs['build'], context.walletKey);
  if (step.id === 'submit') return submitTx(prevOutputs['sign']);
});

if (result.completed) {
  console.log('Done!', result.executedSteps);
} else {
  // Show recovery banner; call manager.execute(op.id, executor) again on user action
  console.log('Paused at step', result.resumedFromStepId, result.error);
}

// 3. Diagnostics (call on app init or periodically)
const diag = manager.getDiagnostics();
console.log('Stuck ops:', diag.stuck.length, 'Abandoned:', diag.abandoned.length);
```

### Recovery banner integration

```typescript
// On app mount, check for recoverable operations
const recoverable = manager.listRecoverable();
if (recoverable.length > 0) {
  showRecoveryBanner(recoverable); // render a UI prompt for each paused op
}
```

### Guarantees

- **No duplicate side effects** — a side-effect step with an existing checkpoint is never re-executed.
- **Concurrent tab safety** — an `in_progress` status prevents a second tab from racing.
- **Abandonment detection** — operations idle for `abandonAfterMs` (default 30 min) are surfaced by `getDiagnostics()`.
- **Automatic cleanup** — `pruneExpired()` removes completed/failed/abandoned operations older than `retentionMs` (default 7 days).

---

## 7. Cross-Service Contract Map (Domain Events & Integration Boundaries)

This section is the canonical contract map for every domain event that crosses
a service boundary in the Trellis frontend.  It enumerates each producer,
consumer, required payload field, version rule, and allowed failure behavior.
It is the source of truth for integration reviews and is enforced by
`tests/__tests__/domain-events-contract.test.ts`.

### 7.1 Event envelope

Every domain event MUST use the following envelope.  Fields marked **required**
are validated at emit time; missing required fields cause the emit to throw
`DomainEventContractError` (see §7.5).

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | `string` (UUID v4) | yes | Unique per emission; used for consumer-side idempotency |
| `eventName` | `string` | yes | Stable identifier, `snake_case`, e.g. `agent.minted` |
| `eventVersion` | `string` (`MAJOR.MINOR`) | yes | See §7.4 for version rules |
| `occurredAt` | ISO-8601 `string` | yes | Producer clock; consumers MUST NOT reorder by this alone |
| `correlationId` | `string` | yes | Ties events to a `RecoverableOperation` (see §1) |
| `producer` | `'web' \| 'api' \| 'worker' \| 'contract'` | yes | Origin service |
| `payload` | `object` | yes | Event-specific; see §7.2 |
| `schemaHash` | `string` (hex) | yes | SHA-256 of the canonical payload schema; see §7.4 |

### 7.2 Producer / consumer matrix

Each row is a contract.  "Required payload fields" lists the minimum set that
consumers may rely on; additional fields are additive and MUST NOT be treated
as required by consumers.

| Event | Producer | Consumers | Required payload fields | Failure behavior |
|---|---|---|---|---|
| `agent.minted` | `web` | `api`, `worker` | `agentId`, `ownerPublicKey`, `capabilities[]` | Retry with backoff; on 3 failures, mark operation `paused` and surface recovery banner |
| `agent.updated` | `web` | `api` | `agentId`, `changedFields[]`, `before`, `after` | Best-effort; log and continue; history chain (§2) is authoritative |
| `wallet.connected` | `web` | `api` | `publicKey`, `network` | Non-blocking; UI proceeds offline-first |
| `wallet.disconnected` | `web` | `api` | `publicKey`, `reason` | Non-blocking |
| `delegation.granted` | `web` | `api`, `contract` | `delegationId`, `grantor`, `grantee`, `permissions[]` | Retry; on chain failure, revert local state and record `chain_break` in history |
| `delegation.revoked` | `web` | `api`, `contract` | `delegationId`, `revokedBy` | Retry; invariant I-11 (§3) must hold after apply |
| `stake.created` | `web` | `api`, `contract` | `stakeId`, `userId`, `amount`, `asset` | Retry; invariant I-08 (§3) must hold |
| `stake.released` | `web` | `api`, `contract` | `stakeId`, `releasedAt` | Retry |
| `import.batch.completed` | `worker` | `web`, `api` | `batchId`, `importedCount`, `skippedCount`, `errors[]` | Idempotent by `batchId`; duplicates ignored |
| `import.batch.failed` | `worker` | `web` | `batchId`, `reason`, `rollbackGuidance` | Surface to user; do not auto-retry |
| `migration.applied` | `api` | `web` | `migrationId`, `version`, `affectedCount` | Informational; web refreshes caches |
| `migration.validation_failed` | `api` | `web` | `migrationId`, `errors[]`, `rollbackNote` | Block further migrations; surface to maintainers |

### 7.3 Integration boundaries

The following boundaries are the only sanctioned crossing points between
services.  Any new event that crosses a boundary MUST be added to §7.2 before
it is emitted in production code.

| Boundary | Direction | Transport | Delivery guarantee | Ordering |
|---|---|---|---|---|
| `web → api` | outbound | HTTPS POST `/api/events` | at-least-once | per `correlationId` |
| `web → contract` | outbound | Stellar transaction | at-most-once (chain) | chain order |
| `api → web` | inbound | SSE `/api/events/stream` | at-least-once | per `correlationId` |
| `worker → web` | inbound | SSE `/api/events/stream` | at-least-once | per `batchId` |
| `api → worker` | internal | queue | at-least-once | per `batchId` |

Consumers MUST be idempotent on `eventId` (or `batchId` for import events).
Duplicate deliveries are expected and are not an error condition.

### 7.4 Version rules

`eventVersion` follows `MAJOR.MINOR`:

- **MINOR** bump: additive fields only.  Producers MAY add fields; consumers
  MUST ignore unknown fields.  No coordination required.
- **MAJOR** bump: removal, rename, or type change of a required field.  A MAJOR
  bump requires a migration plan (§4) and a dual-emit window during which the
  producer emits both versions.  Consumers MUST declare which MAJOR versions
  they accept.
- `schemaHash` MUST change whenever the canonical payload schema changes.  A
  mismatch between producer `schemaHash` and the consumer's registered hash is
  a contract violation and MUST be logged with `eventName` and `eventVersion`.

### 7.5 Allowed failure behavior

| Failure | Allowed? | Required handling |
|---|---|---|
| Unknown `eventName` | yes | Log at `warn`; do not throw; do not retry |
| Unknown extra payload field | yes | Ignore silently |
| Missing required payload field | no | Throw `DomainEventContractError`; do not emit |
| `schemaHash` mismatch | no | Log at `error`; drop event; alert maintainers |
| Duplicate `eventId` | yes | Ignore (idempotent consumer) |
| Out-of-order delivery within `correlationId` | no | Buffer up to 30s; if still out of order, log and apply in arrival order |
| Consumer unavailable | yes | Retry with exponential backoff; after 3 failures mark operation `paused` (§1) |

### 7.6 Operational edge cases

- **Offline PWA**: events emitted while offline are queued in
  `trellis:events:outbox` and flushed on reconnect.  Queue is bounded at 500
  entries; overflow drops the oldest non-critical events and logs a warning.
- **Clock skew**: `occurredAt` is advisory.  Consumers MUST NOT use it for
  ordering decisions; use `correlationId` + arrival order instead.
- **Partial batch**: `import.batch.completed` with `errors.length > 0` is a
  success-with-warnings, not a failure.  UI MUST show the error count.
- **Migration in progress**: while `migration.applied` is pending, web MUST
  serve cached reads and MUST NOT emit `agent.updated` for affected records.

### 7.7 Rollback / recovery

1. **Producer bug**: disable the producer via the feature flag
   `trellis.events.<eventName>.enabled=false`; queued events in the outbox are
   drained and discarded.  No consumer changes required.
2. **Consumer bug**: consumers are additive; roll back the consumer deploy.
   Producers continue emitting; events are buffered by the transport for up to
   24h.
3. **Contract violation (MAJOR)**: follow the migration plan in §4.  Emit both
   versions during the dual-emit window; after all consumers report the new
   version in telemetry for 7 days, remove the old emit.
4. **Schema hash mismatch**: stop the producer, re-derive `schemaHash` from the
   canonical schema, redeploy producer and consumers together.

### 7.8 Verification

The contract map is enforced by
`tests/__tests__/domain-events-contract.test.ts`, which asserts:

- every event in §7.2 has a registered producer and at least one consumer;
- every required payload field is present in the emitted envelope;
- `schemaHash` is stable for a given `(eventName, eventVersion)`;
- unknown events and unknown fields do not throw;
- missing required fields throw `DomainEventContractError`.

Run with:


## 2. Tamper-Evident Change History (Issue #53)

**Location:** `lib/change-history/`

### Problem

Critical records (agent ownership, wallet delegations, stake positions, import
results) can be mutated silently.  Mutable `updatedAt` timestamps alone cannot
prove a record was not changed between two points in time.

### Solution: Per-record SHA-256 hash chain

Every mutation to a critical record creates a `HistoryEntry`.  Each entry
stores the SHA-256 hash of its own content plus the hash of the previous entry
in the same record's chain (`previousHash`).  The first entry uses a fixed
genesis sentinel (`GENESIS_HASH`) as its `previousHash`.

```
[Entry 1]                     [Entry 2]                     [Entry 3]
previousHash: GENESIS_HASH    previousHash: hash(Entry 1)   previousHash: hash(Entry 2)
hash: sha256(content+GENESIS) hash: sha256(content+E1.hash) hash: sha256(content+E2.hash)
```

Verification re-computes every hash and checks:
1. `hash === computeHash(entry content + previousHash)` — content not altered
2. `entry.previousHash === previousEntry.hash` — no entry inserted or removed
3. `occurredAt` timestamps are monotonically increasing — no reordering

### Records protected by default

`agent` · `wallet` · `delegation` · `stake` · `provenance` · `test_case` · `import_batch` · `migration`

### Key files

| File | Purpose |
|---|---|
| `lib/change-history/types.ts` | `HistoryEntry`, `CriticalRecordType`, `ChainVerificationResult`, `HistoryStore` interface |
| `lib/change-history/history-store.ts` | `MemoryHistoryStore`, `LocalStorageHistoryStore`, `computeHash`, `verifyChain` |
| `lib/change-history/history-service.ts` | `HistoryService` — `record()`, `verify()`, `verifyAll()`, `getHistory()` |

### Usage

```typescript
import { getHistoryService } from '@/lib/change-history/history-service';

const historyService = getHistoryService();

// Record a mutation
const entry = await historyService.record({
  recordType:    'agent',
  recordId:      agent.id,
  actor:         wallet.publicKey,
  reason:        'User updated capabilities via settings form',
  before:        existingAgent,   // null for create events
  after:         updatedAgent,
  correlationId: operationManager.getOperation(opId)?.correlationId,
});

// Verify a record's chain
const result = await historyService.verify('agent', agent.id);
if (result.outcome === 'invalid') {
  console.error('Chain violations:', result.violations);
}

// Show history in a UI panel
const chain = historyService.getHistory('agent', agent.id);
// chain[0] is oldest, chain[chain.length - 1] is newest
```

### Verification outcomes

| Violation kind | Meaning |
|---|---|
| `hash_mismatch` | Entry content was altered after the hash was written |
| `chain_break` | An entry's `previousHash` doesn't match the previous entry's hash (insertion or deletion) |
| `out_of_order` | Timestamps are not monotonically increasing (reordering) |

### Tradeoffs

- Hashes are computed in the **browser** — they protect against server-side
  data corruption and display-layer tampering, not against a fully compromised
  client.  For server-side guarantees, replicate this pattern in the backend.
- The chain is per-(recordType, recordId) — cross-record ordering is not
  proven.  This is intentional: it avoids distributed sequencing complexity.

---

## 3. Domain Invariant Test Suite (Issue #55)

**Location:** `lib/domain-invariants.ts`, `tests/__tests__/domain-invariants.test.ts`

### Problem

The domain model can be driven into impossible states through any combination
of API, UI, worker, or contract paths.  Without explicit invariant checks,
these states only surface as downstream bugs that are expensive to diagnose.

### Invariants defined

| ID | Name | Concern | Code path |
|---|---|---|---|
| I-01 | Active agent has author | Ownership | `checkI01ActiveAgentHasAuthor` |
| I-02 | Agent timestamp consistency | Data integrity | `checkI02AgentTimestamps` |
| I-03 | Active agent has capabilities | Lifecycle | `checkI03ActiveAgentHasCapabilities` |
| I-04 | Non-negative balances | Balance | `checkI04NonNegativeBalances` |
| I-05 | Connected wallet has public key | Access | `checkI05ConnectedWalletHasKey` |
| I-06 | Delegation non-self-grant | Access | `checkI06DelegationSelfGrant` |
| I-07 | Granted delegation has permissions | Access | `checkI07GrantedDelegationHasPermissions` |
| I-08 | Stake amounts are non-negative | Balance | `checkI08StakeCoherence` |
| I-09 | On-chain submission has txHash | Data integrity | `checkI09ProvenanceOnChainHasTxHash` |
| I-10 | Import batch no duplicate actions | Data integrity | `checkI10ImportBatchNoDuplicateActions` |
| I-11 | Revoked delegation not regained | Access | `checkI11RevokedDelegationNotRegained` |
| I-12 | No gaps in completed operation steps | Lifecycle | `checkI12OperationStepsNoGaps` |

### Usage in API routes

```typescript
import { checkI04NonNegativeBalances } from '@/lib/domain-invariants';

// Inside an API route or server action, after loading data:
const wallets = await loadWallets();
const violations = checkI04NonNegativeBalances(wallets);
if (violations.length > 0) {
  logger.error('Invariant violation', { violations });
  // Surface to maintainers; do not expose raw detail to end users
}
```

### Adding a new invariant

1. Add a new `InvariantId` literal in `lib/domain-invariants.ts`.
2. Add a snapshot type (if the domain type isn't already covered).
3. Implement the checker function following the existing pattern.
4. Register the invariant in `ALL_INVARIANTS`.
5. Add a happy-path test and at least one violation test in
   `tests/__tests__/domain-invariants.test.ts`.

---

## 4. Migration Safety Framework (Issue #56)

**Location:** `lib/migration/`

### Problem

Schema and data migrations applied without previewing their impact can corrupt
production data.  Without post-checks, a partially-applied migration may look
successful while leaving the store in an inconsistent state.

### Solution: Dry-run + validation + rollback notes

Every migration defines three pieces:
- `up(store)` — applies the change (idempotent by design)
- `validate(store)` — post-migration checks that assert consistency
- `rollbackNote` — prose instructions for manually undoing the migration

The runner's default is `dryRun: true` — a safe default that forces explicit
opt-in to real writes.  Dry-run clones the store, runs `up()` and `validate()`
on the clone, and returns `MigrationPreview[]` with a `safe` flag — all without
touching the real data.

Once applied, the run record is stored in `_migration_runs`, making the runner
idempotent: re-running on deploy is always safe.

### Key files

| File | Purpose |
|---|---|
| `lib/migration/types.ts` | `Migration`, `MigrationStore`, `MigrationUpResult`, `MigrationPreview`, `MigrationRunRecord`, `PostMigrationCheck` |
| `lib/migration/runner.ts` | `MemoryMigrationStore`, `MigrationRunner` |

### Defining a migration

```typescript
import type { Migration } from '@/lib/migration/types';

export const addSchemaVersionToAgents: Migration = {
  id:          'agents-v1-add-schema-version', // stable — never change
  version:     '1.0',
  description: 'Add schemaVersion field to all agent records',
  estimatedAffectedCount: 500,
  rollbackNote: [
    'To roll back: remove the schemaVersion field from all agent records.',
    'Query: DELETE FROM agents WHERE schemaVersion IS NOT NULL (adjust for your store).',
    'Then re-run the import pipeline with dryRun: true to verify.',
  ].join(' '),

  async up(store) {
    const agents = store.getAll('agents');
    for (const agent of agents) {
      store.set('agents', agent.id as string, { ...agent, schemaVersion: '1.0' });
    }
    return { created: 0, updated: agents.length, deleted: 0 };
  },

  async validate(store) {
    const errors: string[] = [];
    for (const agent of store.getAll('agents')) {
      if (!agent.schemaVersion) {
        errors.push(`Agent ${agent.id} is missing schemaVersion after migration`);
      }
    }
    return errors;
  },
};
```

### Running migrations

```typescript
import { MigrationRunner, MemoryMigrationStore } from '@/lib/migration/runner';
import { addSchemaVersionToAgents } from '@/lib/migrations/agents-v1';

const store  = getYourMigrationStore(); // or MemoryMigrationStore for tests
const runner = new MigrationRunner(store);

runner.register(addSchemaVersionToAgents);

// --- Step 1: Always preview first ---
const previewResult = await runner.run({ dryRun: true });
for (const preview of previewResult.previews) {
  console.log(`${preview.migrationId}: safe=${preview.safe}`);
  if (!preview.safe) {
    console.error('Validation errors:', preview.validationErrors);
    console.error('Rollback note:', preview.rollbackNote);
  }
}

// --- Step 2: Apply when preview is safe ---
if (previewResult.previews.every(p => p.safe)) {
  const liveResult = await runner.run({ dryRun: false });
  console.log(`Applied: ${liveResult.success}, Failed: ${liveResult.failed}`);
}
```

### Post-migration checks

```typescript
runner.addPostCheck({
  id:          'no-orphaned-stake-positions',
  description: 'Every stake position must reference a known user',
  async run(store) {
    const errors: string[] = [];
    const userIds = new Set(store.getAll('users').map(u => u.id as string));
    for (const pos of store.getAll('stake_positions')) {
      if (!userIds.has(pos.userId as string)) {
        errors.push(`Orphaned stake position for userId ${pos.userId}`);
      }
    }
    return errors;
  },
});
```

### Rollback procedure

When a live migration fails validation:

1. **Do not re-run the migration** — the run is recorded as `validation_failed`
   and will be retried on the next deploy unless you skip it explicitly.
2. Read the `rollbackNote` from the run record in `_migration_runs`.
3. Apply the manual rollback steps described there.
4. Run a dry-run to confirm the store is back to its pre-migration state.
5. Fix the migration's `up()` or `validate()` logic and redeploy.

---

## 5. Running the Tests

```bash
# Run all four new test suites
npx jest --testPathPattern="recovery-flow|change-history|migration-safety|domain-invariants" --no-coverage

# Run with coverage
npx jest --testPathPattern="recovery-flow|change-history|migration-safety|domain-invariants"

# Run the full suite
npx jest
```

Expected output: all tests pass, zero failures.

---

## 6. Design Decisions and Tradeoffs

### Storage: localStorage over IndexedDB

All four systems use `localStorage` as the default browser persistence layer.
This is intentional: `localStorage` is synchronous, available in all supported
browsers without async setup, and its 5–10 MB limit is sufficient for the
volume of operations, history entries, and migration records expected.

If a specific deployment needs to track tens of thousands of history entries,
swap the default store using the provided `setHistoryStore()` /
`setCheckpointStore()` helpers with an IndexedDB-backed implementation.

### Hash chain scope: per-record, not global

The history hash chain is scoped to `(recordType, recordId)` pairs rather than
being a single global chain.  A global chain would require a distributed lock
to prevent concurrent writes from creating a fork, which is incompatible with
the offline-first PWA model.  Per-record chains give the same tamper-evidence
property for the data that actually matters (individual record history) without
requiring coordination.

### Migration runner: stop-on-first-failure

The runner stops processing after the first failed migration.  Continuing to
apply subsequent migrations when an earlier one is in a bad state risks
cascading corruption.  The trade-off is that a multi-migration deploy may
require multiple manual retries, but this is safer than partial application.

### Recovery engine: no automatic rollback

When a step fails, the engine marks the operation `paused` rather than
attempting to undo previous steps.  Automatic rollback is not implemented
because:
1. Side effects on Stellar (on-chain transactions) cannot be undone at the
   application layer.
2. Automatic rollback logic is as likely to fail as the original step, leaving
   the system in a worse state.

Instead, the `rollbackGuidance` from the import pipeline (Issue #37) provides
the appropriate manual compensation steps for that specific flow.

### Domain invariants: pure functions, not middleware

Invariant checkers are exported as plain functions that take data snapshots and
return violation arrays.  They do not intercept writes or throw exceptions.
This keeps them usable in:
- Jest tests (the primary use case)
- API route handlers (run after loading data, log violations)
- Diagnostic panels (run on-demand by maintainers)

Enforcing invariants as write-time middleware would require restructuring all
mutation paths and could introduce latency; the current design is additive.

---

## Migration Notes

No schema migrations, environment variables, or deployment steps are required
to deploy this change.  All new modules are pure TypeScript libraries that
operate in-process.  The `LocalStorageCheckpointStore` and
`LocalStorageHistoryStore` will create new keys under `trellis:recovery:*` and
`trellis:history:*` namespaces on first use; these do not conflict with
existing keys.
