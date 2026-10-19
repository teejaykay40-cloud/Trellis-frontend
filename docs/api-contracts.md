# Trellis Public API Contracts & Drift Guide

This document specifies the contract definitions, request/response formats, authentication, and error codes for Trellis Frontend endpoints. Automated drift tests enforce that live endpoints match these specifications.

---

## Endpoint Catalog

### 1. Affiliate Endpoints

#### `GET /api/affiliates`
- **Description**: Lists all affiliate sub-endpoints.
- **Auth**: None
- **Response Format**:
```json
{
  "message": "Affiliate API endpoints",
  "endpoints": {
    "stats": "GET /api/affiliates/stats?wallet=<address>",
    "earnings": "GET /api/affiliates/earnings?wallet=<address>&days=<number>",
    "payouts": "GET /api/affiliates/payouts?wallet=<address>",
    "program": "GET /api/affiliates/program",
    "referrals": "GET /api/affiliates/referrals?wallet=<address>",
    "validate": "GET /api/affiliates/validate?wallet=<address>"
  }
}
```

#### `GET /api/affiliates/program`
- **Description**: Returns affiliate program tiers and commission rates.
- **Response Format**:
```json
{
  "tiers": [
    {"name": "Bronze", "commissionRate": 0.05, "minVolumeXlm": 0},
    {"name": "Silver", "commissionRate": 0.10, "minVolumeXlm": 5000},
    {"name": "Gold", "commissionRate": 0.15, "minVolumeXlm": 25000}
  ],
  "cookieDurationDays": 30
}
```

---

### 2. Metrics & Observability

#### `GET /api/metrics/panels`
- **Description**: Returns all configured dashboard panels.
- **Response Format**:
```json
{
  "source": "prometheus | mock",
  "panels": [
    { "id": "agent-executions", "title": "Agent Invocations", "type": "timeseries" }
  ]
}
```

---

### 3. Bulk Ingestion Pipeline

#### `POST /api/import/dry-run`
- **Description**: Previews import changes with zero persistent writes.
- **Query Params**:
  - `entityType` (optional, default: `general`): `agents` | `test-cases` | `provenance` | `submissions`
- **Response Format (200 OK)**:
```json
{
  "success": true,
  "dryRun": true,
  "entityType": "agents",
  "summary": {
    "totalRows": 1,
    "validRows": 1,
    "invalidRows": 0,
    "createCount": 1,
    "updateCount": 0,
    "skipCount": 0,
    "errorCount": 0,
    "duplicateCount": 0
  },
  "rows": [
    { "rowNumber": 1, "action": "create", "valid": true, "errors": [] }
  ]
}
```

---


---

### 4. Bug Reports & Cursor Pagination

#### `GET /api/bug-reports`
- **Description**: Returns paginated bug reports supporting cursor-based pagination and status filtering.
- **Auth**: None (or optional actor context)
- **Query Params**:
  - `cursor` (optional, string): Opaque forward pagination cursor from `nextCursor`.
  - `limit` (optional, integer, default: 20, max: 50): Page size boundary.
  - `status` (optional, string): `open` | `in_progress` | `resolved` | `closed`.
- **Response Format (200 OK)**:
```json
{
  "reports": [
    {
      "id": "br_1234567890_abc",
      "title": "Simulation timeout on mainnet",
      "description": "Details regarding timeout...",
      "status": "open",
      "severity": "medium",
      "createdAt": "2026-10-18T12:00:00.000Z",
      "updatedAt": "2026-10-18T12:00:00.000Z"
    }
  ],
  "nextCursor": "br_1234567890_abc",
  "hasMore": false,
  "total": 1
}
```

---

### 5. Retry & Dead-Letter Queue Management

#### `GET /api/retry/dead-letters`
- **Description**: Lists terminal operation failures recorded in the bounded dead-letter queue.
- **Auth**: Bearer token validated against `DEAD_LETTER_ADMIN_TOKEN`.
- **Query Params**:
  - `reason` (optional, string): `retries_exhausted` | `non_retryable` | `abandoned`
  - `operationClass` (optional, string): `transaction` | `sync` | `webhook` | `import` | `export` | `background_job` | `http_request` | `rpc`
  - `operationId` (optional, string): Filter by specific operation ID.
  - `includeResolved` (optional, boolean, default: `false`): Include triaged records.
  - `limit` (optional, integer, default: 50, max: 200): Record count boundary.
- **Response Format (200 OK)**:
```json
{
  "records": [
    {
      "id": "dlq_abcd1234_xyz",
      "operationClass": "transaction",
      "operationId": "tx-10492",
      "reason": "retries_exhausted",
      "classification": {
        "kind": "network_transient",
        "retryable": true,
        "suggestedBackoffMs": 5000
      },
      "attempts": [
        {
          "attempt": 0,
          "startedAt": "2026-10-18T10:00:00.000Z",
          "durationMs": 150,
          "classification": { "kind": "network_transient", "retryable": true }
        }
      ],
      "attemptsCount": 1,
      "firstFailedAt": "2026-10-18T10:00:00.000Z",
      "deadLetteredAt": "2026-10-18T10:05:00.000Z",
      "context": { "wallet": "GB..." }
    }
  ],
  "stats": {
    "total": 1,
    "unresolved": 1,
    "resolved": 0,
    "dropped": 0
  }
}
```

#### `POST /api/retry/dead-letters`
- **Description**: Triages or replays a dead-letter record with strict idempotency and double-resolution prevention.
- **Auth**: Bearer token validated against `DEAD_LETTER_ADMIN_TOKEN`.
- **Request Body**:
```json
{
  "id": "dlq_abcd1234_xyz",
  "outcome": "replayed",
  "notes": "Re-executed after network recovery"
}
```
- **Response Format (200 OK)**:
```json
{
  "success": true,
  "record": {
    "id": "dlq_abcd1234_xyz",
    "resolution": "replayed",
    "resolutionNotes": "Re-executed after network recovery",
    "resolvedAt": "2026-10-18T10:15:00.000Z"
  }
}
```

---

### 6. Streaming Data Export & Authorization Boundaries

#### `POST /api/export`
- **Description**: Generates streaming CSV/JSON export for authorized actors within retention boundaries.
- **Auth**: Matrix authorization via actor bearer token (`action: "export_data"`). Minimum required role is `contributor` for own resources, `maintainer` for project resources.
- **Request Body**:
```json
{
  "wallet": "GBBDES777NN7VUXK4G576WJW7S5U76EOMSKJEXL567WZ5H5R2V73TEST",
  "type": "simulations",
  "from": "2026-08-01T00:00:00.000Z",
  "to": "2026-10-18T00:00:00.000Z",
  "format": "json"
}
```
- **Response Format (200 OK)**: Streaming chunks with `Content-Type: application/json` or `text/csv`.
- **Error Responses**:
  - `401 Unauthorized`: Missing or malformed authentication header.
  - `403 Forbidden`: Insufficient role permissions (`denied_by_policy`).
  - `422 Unprocessable Entity`: Requested date range exceeds data type retention window.

## Cross-Service Contract Map: Domain Events & Integration Boundaries

This section is the authoritative map of domain events that cross service boundaries in the Trellis system. Every event has exactly one producer and one or more consumers. The map is enforced by `___tests___/contracts/domain-events.test.ts` (see %Contract Verification% below).

### Event Envelope

All domain events are transported as JSON objects with the following envelope. The envelope is stable across all event types; only `data` changes per event.

```json
{
  "id": "<canonical uuid>",
  "type": "<domain.event.name>",
  "version": "<major>`.`<minor>`.`<patch>`",
  "occurredAt": "<ISO-8601 timestamp>",
  "producer": "<service name>",
  "correlationId": "<uuid or null>",
  "data": { }
}
```

### Event Registry

| Event type | Producer | Consumers | Required `data` fields | Version rule | Allowed failure behavior |
|------------|----------|-----------|----------------------|--------------|--------------------------|
| `affiliate.registered` | Affiliate API | Metrics service, Notifications service | `wallet`, `tier`, `referralCode` | additive only; consumers must ignore unknown fields | consumer retries with exponential backoff; event is dropped after 5 attempts with a dead-letter record |
| `affiliate.earnings.accrued` | Affiliate API | Metrics service, Dashboard read model | `wallet`, `amountXlm`, `currency` | additive only; major bump required to remove or rename a field | consumer must not block the producer; failure is logged and retried out-of-band |
| `affiliate.payout.requested` | Affiliate API | Payments service, Notifications service | `wallet`, `amountXlm`, `payoutId` | additive only; consumers must ignore unknown fields | consumer retries with exponential backoff; event is dropped after 5 attempts with a dead-letter record |
| `affiliate.payout.completed` | Payments service | Affiliate API, Metrics service, Notifications service | `wallet`, `payoutId`, `txHash` | additive only; consumers must ignore unknown fields | consumer retries with exponential backoff; event is dropped after 5 attempts with a dead-letter record |
| `import.dry-run.completed` | Bulk Ingestion Pipeline | Metrics service, Dashboard read model | `entityType`, `summary`, `durationMs` | additive only; major bump required to remove or rename a field | consumer must not block the producer; failure is logged and retried out-of-band |
| `import.commit.completed` | Bulk Ingestion Pipeline | Metrics service, Dashboard read model, Notifications service | `entityType`, `summary`, `durationMs` | additive only; major bump required to remove or rename a field | consumer must not block the producer; failure is logged and retried out-of-band |
| `metrics.panel.configured` | Metrics service | Dashboard read model | `panelId`, `title`, `type` | additive only; consumers must ignore unknown fields | consumer must not block the producer; failure is logged and retried out-of-band |

### Version Rules

1. Every event carries a semantic version in `version` using `SemVer` format.
2. **Additive changes** (adding a new optional field) bump the **patch** version and do not require consumer changes. Consumers must ignore unknown fields.
3. **Behavioral changes** (changing a field's meaning or default) bump the **Minor** version. Consumers must handle both old and new minor versions during a migration window.
4. **Breaking changes** (removing or renaming a required field, changing types) bump the **Major** version and require a documented migration plan in this file.
5. Producers must not remove a field without a major version bump.
6. Consumers must not reject an event solely because it contains unknown fields.

### Allowed Failure Behavior

- **Producer failure**: If a producer cannot emit an event, the underlying user operation must still succeed when the event is not required for correctness (e.g. metrics, notifications). The failure is logged and retried out-of-band.
- **Consumer failure**: Consumers must not block the producer. Failed consumption is retried with exponential backoff and dropped after 5 attempts with a dead-letter record.
- **Ordering**: Events are not globally ordered. Consumers that require ordering must use `occurredAt` and `correlationId` to reconstruct sequence.
- **Duplicates**: Events are at-least-once delivered. Consumers must be idempotent keyed on the envelope `id`.

### Operational Edge Cases

- **Out-of-order delivery**: A consumer may receive `affiliate.payout.completed` before `affiliate.payout.requested`. Consumers must tolerate this and reconcile via `payoutId`.
- **Duplicate delivery**: The same event may be delivered more than once. Consumers must de-dupe on `id`.
- **Partial failure**: If a consumer fails after partially processing an event, the retry must resume idempotently.
- **Schema drift**: If a producer emits a field not in this map, consumers must ignore it and not fail.
- **Missing required field**: If a required field is missing, the consumer must log and route the event to the dead-letter queue without blocking other events.

### Failure Modes

| Mode | Detection | Response |
|------|----------|----------|
| Producer emits unknown event type | Consumer receives type not in registry | Log and drop; alert if rate exceeds threshold |
| Required field missing | Schema validation fails | Route to dead-letter queue; do not block producer |
| Version major mismatch | Consumer sees major bump without support | Reject and alert; require consumer upgrade |
| Dead-letter queue growing | Queue depth monitor alert | Operator investigates and replays after fix |
| Consumer down for extended period | Health check fails | Events buffer in queue; replay on recovery |


### Contract Boundary & Resilience Matrix

| Boundary | Normal Behavior | Edge Case / Threshold | Failure Code / Action | Recovery Runbook |
|---|---|---|---|---|
| **Cursor Pagination** | Returns `reports[]` + `nextCursor` | Terminal page returns `hasMore: false` and `nextCursor: null` | Invalid cursor falls back to first page or returns 400 | Re-query with initial empty cursor |
| **Dead-Letter Limit** | Returns up to `limit` records | Upper bound enforced at `limit <= 200`; non-integer/negative rejected | `400 invalid_limit` | Clamp client page request to `1 <= limit <= 200` |
| **Dead-Letter Filter** | Filters by valid reason & registered `OperationClass` | Unregistered class or unrecognized reason | `400 invalid_reason` / `400 invalid_operation_class` | Verify against `OPERATION_CLASSES` registry |
| **Dead-Letter Secret** | Constant-time token match | Secret missing on server | `503 not_configured` (Fails closed) | Configure `DEAD_LETTER_ADMIN_TOKEN` secret in environment |
| **Export Role Gate** | Permits `contributor`, `maintainer`, `admin` | `viewer` or unauthorized role | `403 denied_by_policy` | Elevate role or obtain action-scoped capability token |
| **Export Retention** | Streams data within retention bounds | `from` > `to` or range exceeds `RETENTION_DAYS` (simulations: 365d, analytics: 730d, telemetry: 90d) | `422 Unprocessable Entity` | Narrow date window within retention limits |
| **DLQ Double Resolution** | Marks record `replayed` or `discarded` | Resolving an already-resolved record | `409 Conflict` | Fetch fresh DLQ status; confirm resolution notes |

### Dead-Letter Queue Replay & Rollback Runbook

1. **Triage Inspection**:
   Query `GET /api/retry/dead-letters?limit=50&includeResolved=false` using an authorized admin token.
2. **Root Cause Analysis**:
   Inspect `classification.kind` (`network_transient`, `rate_limited`, `permanent`, etc.) and `attempts[]` duration/history.
3. **Idempotent Replay**:
   Submit `POST /api/retry/dead-letters` with `outcome: "replayed"`. If underlying operation is retryable, execute with original `operationId`.
4. **Resolution Conflict Handling**:
   If a `409 Conflict` is returned, another maintainer or process has already resolved the record. Inspect `record.resolution` and `record.resolutionNotes`.
5. **Discarding Non-Viable Operations**:
   If payload or underlying transaction cannot succeed, resolve with `outcome: "discarded"` and document reasoning in `notes`.

### Rollback / Recovery Steps

1. **Disable the consumer** by removing it from the consumer group and letting events buffer in the queue.
2. **Revert the consumer deployment** to the last known-good commit.
3. **Replay from the dead-letter queue** after the fix is deployed, using the original `correlationId`.
4. **Verify idempotency** by re-playing the same event id and confirming no duplicate side effects.
5. **Restore the consumer** to the consumer group and confirm lag returns to baseline.

### Contract Verification

The map is enforced by `___tests___/contracts/domain-events.test.ts`, which asserts:

- Every event type in the registry has at least one producer and one consumer.
- Every required `data` field is present in the event's schema.
- Every event carries a valid `SemVer` `version`.
- Every consumer declares an allowed failure behavior.
- The envelope fields (`id`, `type`, `version`, `occurredAt`, `producer`, `correlationId`, `data`) are present on every event.

---

## Error Handling Standards
All API error responses follow the standard Trellis error payload:
```json
{
  "error": "Human readable error message",
  "code": "ERROR_CODE_STRING",
  "details": []
}
```
