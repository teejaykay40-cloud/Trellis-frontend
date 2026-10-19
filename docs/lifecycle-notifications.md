# Lifecycle & Recovery Notification System

## Overview
The Trellis Lifecycle Notification System manages critical alerts, user actions, lifecycle transitions, and recovery guidance.

---

## Key Features

1. **Deduplication (`dedupKey`)**:
   - Every event has a unique or deterministic deduplication key.
   - Retried events, background task polling, or duplicate webhooks will never create redundant notifications.

2. **Recipient Isolation**:
   - Notifications with `recipientWallet` are strictly visible to that specific wallet address.
   - Prevents private data leakage between players and developers.

3. **Recovery Deep Links**:
   - Critical failures (such as `transaction_failed`, `rate_limit_warning`, `recovery_action_required`) contain embedded `recoveryAction` objects with direct deep links to remediation workflows.

---

## Event Catalog
- `agent_minted`: New agent deployment confirmed on Soroban.
- `agent_upgraded`: Contract bytecode or metadata upgrade applied.
- `simulation_completed` / `simulation_failed`: Simulation test engine completion or failure.
- `transaction_failed`: On-chain execution failure with retry / recovery link.
- `recovery_action_required`: User action needed for wallet or contract state recovery.
- `rate_limit_warning`: Notification when API or gas budget reaches threshold.

---

## Webhook Authentication & Security

Inbound webhooks (e.g., from external providers or internal services) to the lifecycle route are cryptographically verified to prevent unauthorized events and replay attacks.

### Verification Flow

1. **Signature Verification**: The `x-webhook-signature` header must contain a valid HMAC-SHA256 signature, signed using `WEBHOOK_SECRET`. The signature is computed over the string `<timestamp>.<payload>`.
2. **Replay Window**: The `x-webhook-timestamp` header is evaluated to ensure the webhook was sent recently (default maximum window: 5 minutes). Stale events are rejected.
3. **Idempotency**: The `x-webhook-event-id` header is tracked. If the exact event ID is processed again, it is blocked as a duplicate.

---

## Cross-Service Contract Map

This section is the normative contract between every producer and consumer of domain events in the Trellis lifecycle pipeline. Any change to a producer payload, a consumer expectation, or a version rule must be reflected here and covered by the executable verification in `tests/contract-map.ts`.

### Transport Boundaries

| Boundary | Direction | Protocol | Auth | Retry |
| --- | --- | --- | --- | --- |
| `chain-indexer` -> `internal-event-bus` | inbound | JSON over HTTP | HMAC-SHA256 webhook signature | exponential backoff, max 5 attempts |
| `simulation-engine` -> `internal-event-bus` | inbound | JSON over HTTP | HMAC-SHA256 webhook signature | exponential backoff, max 5 attempts |
| `wallet-service` -> `internal-event-bus` | inbound | JSON over HTTP | HMAC-SHA256 webhook signature | exponential backoff, max 5 attempts |
| `internal-event-bus` -> `lifecycle-route` | internal | in-process dispatch | none (trusted process boundary) | in-process retry, max 3 attempts |
| `lifecycle-route` -> `notification-store` | outbound | SQL transaction | none (server-side trusted) | transaction retry on deadlock, max 2 attempts |
| `notification-store` -> `web-client` | outbound | SSE / WebSocket | session token | client reconnect with last event cursor |

### Event Contracts

Every event envelope shares these required fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (UUIDv4) | yes | Globally unique event identifier. Used as `x-webhook-event-id` for idempotency. |
| `type` | string enum | yes | One of the event types in the Event Catalog. |
| `version` | string | yes | Semantic version of the payload schema (e.g. `1.0.0`). |
| `occurredAt` | string (RTC 3339 ISO-8601) | yes | Producer clock timestamp. |
| `dedupKey` | string | yes | Deterministic key derived from `(type, aggregateId, version)`. |
| `recipientWallet` | string (Stellar address) | no | When present, notification is visible only to this wallet. |
| `payload` | object | yes | Type-specific body, validated against the contract below. |

##### `agent_minted`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `agentId` | string | yes | Soroban agent identifier. |
| `contractId` | string | yes | Deployed contract address. |
| `ownerWallet` | string | yes | Owner Stellar address. |
| `txHash` | string | yes | Mint transaction hash. |

Producer: `chain-indexer`. Consumers: `lifecycle-route`, `web-client`.

##### `agent_upgraded`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `agentId` | string | yes | Soroban agent identifier. |
| `fromVersion` | string | yes | Previous bytecode/version. |
| `toVersion` | string | yes | New bytecode/version. |
| `txHash` | string | yes | Upgrade transaction hash. |

Producer: `chain-indexer`. Consumers: `lifecycle-route`, `web-client`.

##### `simulation_completed` / `simulation_failed`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `simulationId` | string | yes | Simulation run identifier. |
| `agentId` | string | yes | Soroban agent identifier. |
| `durationMs` | number | yes | Wall-clock duration in milliseconds. |
| `failureReason` | string | no | Required when `type = simulation_failed`. |

Producer: `simulation-engine`. Consumers: `lifecycle-route`, `web-client`.

##### `transaction_failed`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `txHash` | string | yes | Failed transaction hash. |
| `reason` | string | yes | Machine-readable failure code. |
| `recoveryAction` | object | yes | `{ type, deepLink\ }. |

Producer: `wallet-service`. Consumers: `lifecycle-route`, `web-client`.

##### `recovery_action_required`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `recoveryAction` | object | yes | `{ type, deepLink } `. |
| `severity` | string enum | yes | `info` | `warning` | `critical`. |
Producer: `wallet-service`. Consumers: `lifecycle-route`, `web-client`.

##### `rate_limit_warning`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scope` | string enum | yes | `api` | `gas`. |
| `thresholdPct` | number | yes | Percentage of budget consumed (0-100). |
| `recoveryAction` | object | yes | `{ type, deepLink }`. |

Producer: `wallet-service`. Consumers: `lifecycle-route`, `web-client`.

### Version Rules

1. **Semantic versioning.** Event payloads follow `MAJOR.MINOR.PATCH`.
2. **Backward-compatible additions** (PPATCH) may be added without a consumer change. Consumers must ignore unknown fields.
3. **Removals or type changes** require a MAJOR bump and a dual-write migration window of at least one release cycle.
4. **Unknown MAJOR versions** must be rejected by the lifecycle route with HTTP 422 and logged as `contract_version_unsupported`.
5. **Dedup key stability** is part of the contract: the derivation function must not change within a MAJOR version.

### Allowed Failure Behavior

| Failure | Owner | Behavior | Recovery |
| --- | --- | --- | --- |
| Signature mismatch | `lifecycle-route` | Reject with 401, no store write, emit `webhook_signature_rejected` telemetry. | Producer rotates secret and resends. |
| Stale timestamp | `lifecycle-route` | Reject with 408, no store write. | Producer resends with fresh clock. |
| Duplicate event ID | `lifecycle-route` | Return 200 with `duplicate: true`, no second notification. | No action required. |
| Unsupported version | `lifecycle-route` | Reject with 422, emit `contract_version_unsupported` telemetry. | Operator upgrades consumer or producer. |
| Notification store unavailable | `lifecycle-route` | Return 503, buffer event in dead-letter queue. | Replay dead-letter queue after store recovery. |
| Client disconnect | `web-client` | Reconnect with last event cursor. | No user action required. |

### Operational Edge Cases

- **Clock skew.** Producers must synchronize via NTP within ±30 seconds. Timestamps outside the replay window are rejected.
- `**Webhook secret rotation.** During rotation, the route accepts both the current and the previous secret for a maximum of 10 minutes.
- **Burst traffic.** The dedup store must retain event IDs for at least 24 hours to cover retries.
- **Partial failure in multi-consumer dispatch.** Each consumer is dispatched independently; a failure in one consumer does not block the others.

### Rollback / Recovery Steps

1. **Disable a producer** by removing its webhook secret from the route configuration. Inbound events will be rejected with 401.
2. **Drain the dead-letter queue** once the downstream dependency is restored by replaying events in `occurredAt` order.
3. **Revert a consumer release** by redeploying the previous image; the event bus retains events for 24 hours, so no data is lost.
4. **Verify recovery** by running `npm test -- contract-map` and confirming all producer/consumer pairs resolve.

### Executable Verification

The contract map is enforced by `tests/contract-map.ts`, which validates that:

- every event type in the Event Catalog has a producer and at least one consumer declared above;
+- every required field is present in the corresponding fixture payload;
- the dedupKey derivation is deterministic and stable across runs;
- unknown MAJOR versions are rejected with 422;
- duplicate event IDs return 200 with `duplicate: true` and do not write a second notification.
