# Deterministic multi-client conflict resolution

`lib/conflict-resolver.ts` provides an additive resolver for versioned JSON
records. It does not change the existing `detectConflict` result, session-sync
wire format, offline queue, or their retry contracts. Callers provide a
versioned store with an atomic compare-and-swap operation and an authorization
callback; the server/store remains authoritative.

## Resolution contract

- The resolver authorizes the actor for the resource on every attempt and
  denies access before reading the record. Authorization errors are returned
  separately from denials.
- Disjoint edits are merged recursively. For a leaf changed differently by
  both clients, the lexicographically greater canonical JSON value wins
  (deletion sorts before JSON values). This rule is associative across
  successive merges and does not depend on arrival order or document-level
  writer metadata; returned conflict paths use JSON Pointer escaping and
  sorted order.
- The resolver commits only with compare-and-swap against the exact version it
  read. A failed CAS causes a fresh authorized read and merge, up to
  `maxAttempts` (default: 3, hard maximum: 10). Exhaustion is explicit; callers
  should surface the conflict and let the user refresh or retry later rather
  than replaying indefinitely.
- An operation already recorded as the latest writer with the same identity is
  idempotently reported as `already_applied`, including when the original
  caller did not receive its successful response. Callers must never reuse an
  operation identity for a distinct edit. Store and authorization exceptions
  are returned with their phase/cause and are not treated as successful
  writes.
- Stores may implement the optional `findAppliedVersion(resourceId,
  identity)`. When present, an operation committed earlier is reported as
  `already_applied` even after another client has written on top of it.
  Without it, such a retry merges again from its original base and can revert
  the newer edit. See
  [concurrent-write-replay.md](./concurrent-write-replay.md#lost-response--intervening-write-can-resurrect-stale-data).
- Inputs must be JSON-compatible object documents. Proposals based on future
  versions or inconsistent base snapshots are rejected.

## Recovery and rollback

On `retry_exhausted`, refresh the record and let the caller submit a new
proposal using that snapshot as its base. On `storage_error` or
`authorization_error`, report the failure and retry only after the underlying
service is healthy; the resolver makes no success-shaped fallback. Preserve
the original proposal and operation identity when retrying an uncertain
request so a successful prior write can be recognized.

This is a client-side library contract and requires no schema migration.
Rollback consists of reverting callers to their prior conflict workflow; no
persisted data or wire-format migration is required. The backing store must
implement atomic version compare-and-swap: without it, multi-client writes
cannot be made safe by this resolver.
