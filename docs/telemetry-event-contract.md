# Telemetry Event Contract

This document defines the minimum safe event shape for the existing client telemetry surface. It gives application features one shared contract for recording outcomes without turning telemetry into a source of user or wallet data.

## Required Fields

Every event includes:

| Field | Meaning |
| --- | --- |
| `id` | Unique event identifier. |
| `ts` | Event timestamp in milliseconds. |
| `agentRef` | Opaque, non-identifying actor reference. |
| `type` | `heartbeat`, `status`, `error`, `task_started`, or `task_completed`. |
| `severity` | `debug`, `info`, `warn`, `error`, or `critical`. |

The optional payload may contain only a correlation ID, operation kind, state, stable error code, and a human-safe message.

## Operation Names

Use stable, low-cardinality values for `taskKind`, such as `wallet_connect`, `wallet_sign`, `arena_load`, `transaction_submit`, or `data_refresh`. Do not include identifiers, route parameters, transaction XDR, request bodies, wallet addresses, or free-form user input in an operation name.

## Outcomes And Latency

For an operation that starts and completes, emit `task_started` and `task_completed` with the same opaque `correlationId`. Include a terminal `state` such as `succeeded`, `failed`, `cancelled`, or `timed_out`. The producer or dashboard may derive latency from the two timestamps; do not add unbounded timing labels.

Failures should use a stable `code` such as `wallet_unavailable`, `user_rejected`, `network_mismatch`, `rpc_unavailable`, or `request_timeout`. Error messages must be useful to operators while remaining safe to expose.

## Privacy Boundary

The telemetry sanitizer removes sensitive keys and redacts obvious email and long base64-like values. Producers must still avoid sending passwords, tokens, cookies, IP addresses, names, account IDs, addresses, public keys, private keys, raw transaction payloads, and stack traces. Sanitization is defense in depth, not permission to emit sensitive data. The client stream accepts at most 30 events per second and retains at most 500 events; excess events are dropped from the dashboard view. Metric labels use a fixed key allow-list, reject malformed or overlong values, normalize common ID-shaped route segments, and retain at most six dimensions. Prometheus responses are capped at 200 series and 1,000 newest points per series.

## Metric Export (OTLP)

`lib/metric-definitions.ts` records client counters, histograms, and gauges through `OtlpMetricExporter`, which batches buffered points and POSTs OTLP/HTTP JSON to a collector.

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; `/v1/metrics` is appended automatically. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Signal-specific override, used as-is. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` (default), `http/protobuf`, or `grpc`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` collector headers. |
| `OTEL_SERVICE_NAME` | Resource `service.name` value. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Batch interval in milliseconds (default 30000). |
| `OTEL_METRIC_ALLOW_UNSAFE` | `true` bypasses the `SAFE_METRICS` allow-list (local debugging only). |

The browser bundle only sees `NEXT_PUBLIC_*` variables, so client-side export uses `NEXT_PUBLIC_OTEL_EXPORTER_OTLP_*`. Omit the endpoint entirely to keep metrics local — the exporter then buffers without transmitting.

Batches use delta temporality: counters are encoded as monotonic sums, histograms carry explicit bucket bounds plus string bucket counts, and gauges carry the last observed value. Attribute keys failing `isFieldSafe` and metric names outside `SAFE_METRICS` are dropped before encoding, so exported batches stay inside the privacy boundary above.

The client always transmits OTLP/HTTP JSON. A `grpc` protocol value is treated as a transport hint for the collector setup and still goes over the HTTP endpoint; wire a real gRPC transport only if a collector requires it.

## Dashboard Queries

The primary operational views should group by `type`, `severity`, `taskKind`, `state`, and `code` only. These bounded dimensions support failure-rate and conversion analysis without creating a high-cardinality or personally identifying metric stream.

## Cardinality and overload operations

Unknown metric label keys and values outside the supported formats are omitted from rendered series. When a collector returns too many series or points, the dashboard keeps the first 200 series and newest 1,000 points per series; inspect the collector query and its label dimensions if expected data is missing. The live telemetry view drops events above its 30-per-second display budget, so it is intended for operational visibility rather than complete audit storage. Persist audit events in the protected server-side system of record.

If a legitimate dashboard dimension is missing, add its key and a bounded value rule to `lib/metrics/sanitize.ts` and cover it with a sanitizer test. If a panel regularly reaches the response caps, reduce cardinality in its PromQL query or increase the exported caps with a documented browser memory budget. Recovery requires no data migration: the limits apply only to client-rendered responses, and reconnecting or reloading resumes the current stream. To roll back, revert the sanitizer and cap changes together; do not disable server-side privacy filtering.

## Transports

The dashboard prefers an unordered, unreliable WebRTC data channel (`ordered: false`, `maxRetransmits: 0`) because a
stale metric tick must never delay the ticks behind it. The existing WebSocket stream remains the transport whenever
WebRTC is unsupported, ICE does not complete, or no producer peer is connected, so the event contract above is
identical on both paths.

Connection state, the active transport, and the reason for any fallback are exposed by `useTelemetryStream` (and its
useTelemetryWebSocket compatibility wrapper). Configuration lives in `NEXT_PUBLIC_TELEMETRY_WEBRTC`,
`NEXT_PUBLIC_TELEMETRY_STUN_URLS`, `NEXT_PUBLIC_TELEMETRY_TURN_URL`, and `NEXT_PUBLIC_TELEMETRY_ICE_SERVERS`.

## Operational Metadata Classification & Retention Enforcement

To prevent telemetry metadata from expanding into long-term tracking or holding unnecessary operational state, operational metadata is classified and bounded by deterministic retention policies:

### Metadata Classification Tiers

| Tier | Scope & Contents | Retention Window | Max Capacity |
| --- | --- | --- | --- |
| `PUBLIC` | Heartbeats, aggregated health indicators, non-identifying status signals. | 30 days (default) | 1,000 events |
| `OPERATIONAL` | Task lifecycle events (`task_started`, `task_completed`), non-identifying operation counters. | 7 days | 500 events |
| `SENSITIVE` | Errors, warnings, critical traces, bounded diagnostic error codes. | 24 hours | 200 events |
| `RESTRICTED` | Disallowed/PII keys (tokens, passwords, keys, seeds, cookies, PII). | 0 ms (Immediate Purge) | 0 (Never stored) |

### Minimization Review

Before operational metadata is admitted into local storage or buffers, `reviewAndMinimizeMetadata` enforces:
1. **Allowlist Schema Check**: Only allowed payload fields (`correlationId`, `taskKind`, `state`, `code`, `message`) are retained; any extraneous or unexpected fields are discarded.
2. **Key Denial Pattern**: Restricted keys (e.g. `password`, `secret`, `token`, `api_key`, `seed`, `private_key`) are stripped immediately.
3. **Value Redaction**: Any embedded email addresses, Stellar secret seeds (`S...`), or base64 token blobs within message strings are redacted with standardized tokens (`[redacted_email]`, `[redacted_stellar_seed]`, `[redacted_secret]`).
4. **Retention Timestamp**: An explicit expiration timestamp `expiresAt` is attached according to the event's classification tier.

### Retention Enforcement & Testable Deletion

The `OperationalMetadataRetentionStore` manages metadata lifecycle:
- **`enforceRetention(now)`**: Scans stored metadata, deletes records whose `expiresAt <= now`, and creates audit log records (`expired`).
- **`deleteRecord(id, reason)`**: Provides testable and programmatic deletion of single operational metadata entries with audit tracking (`manual`).
- **`purgeClassification(tier)`**: Purges all records of a given classification tier on demand during incident containment (`purge_classification`).
- **`enforceTierCapacity(tier)`**: Enforces FIFO/LRU eviction when tier capacity limits are reached (`quota_exceeded`).

### Operational Edge Cases & Failure Modes

1. **Clock Skew or Client Time Jumps**:
   - *Failure Mode*: Client system clock adjustments or jumps forward could prematurely expire valid operational records; backward jumps could delay expiration.
   - *Mitigation*: Retention enforcement calculates relative windows at ingestion using monotonic elapsed timestamps where available, and stores explicit UTC epoch expiration stamps.
2. **Buffer/Storage Overload During Burst Traffic**:
   - *Failure Mode*: Rapid spikes in error events could exhaust memory or storage quotas.
   - *Mitigation*: Tier-based capacity limits (`maxEntries`) immediately evict oldest records under the same classification before quota breach occurs.
3. **Unexpected Payload Field Ingestion**:
   - *Failure Mode*: An upstream producer introduces non-contract debugging properties.
   - *Mitigation*: The strict minimization allowlist automatically drops unauthorized fields without breaking the ingestion pipeline or terminating the stream.

### Rollback and Recovery Steps

- **Disabling Retention Pruning**: In case of emergency troubleshooting where historical events must be temporarily preserved, set tier retention windows to `Infinity` via `store.setPolicy(tier, { ...policy, retentionWindowMs: Infinity })`.
- **Restoring Dropped Metadata**: Minimization is applied at ingestion defense-in-depth; to roll back minimization policies, adjust `ALLOWED_PAYLOAD_FIELDS` in `lib/telemetry/minimizationReview.ts` to accommodate newly standardized contract fields.
- **Rollback**: Changes to classification rules and retention store remain fully backwards compatible with `TelemetryEvent` and legacy subscriber hooks. Reverting commits restores previous passthrough behavior without requiring database or migration runs.

## Cross-Service Contract Map

This section maps every domain event producer to its consumers, the required fields for each event type, the version rules that govern changes, and the allowed failure behavior at each integration boundary.

### Producer/Consumer Matrix

| Event type | Producer | Consumers | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| `heartbeat` | Client telemetry stream (`useTelemetryStream`) | Dashboard live view, Prometheus exporter | id, ts, agentRef, type, severity | correlationId, state |
| `status` | Client telemetry stream | Dashboard live view, Prometheus exporter | id, ts, agentRef, type, severity | correlationId, taskKind, state |
| `error` | Client telemetry stream, wallet adapter | Dashboard live view, Prometheus exporter, retention store | id, ts, agentRef, type, severity, code | correlationId, taskKind, state, message |
| `task_started` | Client telemetry stream, wallet adapter, arena loader | Dashboard live view, Prometheus exporter, retention store | id, ts, agentRef, type, severity, correlationId, taskKind | code, message |
| `task_completed` | Client telemetry stream, wallet adapter, arena loader | Dashboard live view, Prometheus exporter, retention store | id, ts, agentRef, type, severity, correlationId, taskKind, state | code, message |

### Version Rules

Every event is governed by the following rules. They are enforced by the contract tests in `tests/telemetry/contract-map.ts`.

1. **Additive changes are minor versions.** Adding a new optional payload field or a new `taskKind` value is backward compatible and does not require a consumer release.
2. **Required field additions are major versions.** A new required field or a new event `type` must be added to this document and to the contract test before any producer emits it. Consumers must tolerate unknown fields by ignoring them.
3. **Removing a field or type is a major version.** Removal requires a migration note in this document and a deprecation window of at least one release cycle.
4. **Severity and code values are closed enums.** New values require a documentation update and a consumer test before being emitted.
5. **Consumers must not fail closed on unknown fields.** Unknown payload keys are dropped by minimization rather than rejecting the event.

### Allowed Failure Behavior

| Boundary | Failure mode | Allowed behavior |
| --- | --- | --- |
| Producer -> client stream | Event exceeds 30 events/second or 500 event buffer | Drop excess events from the dashboard view; do not throw or block the producer. |
| Producer -> client stream | Malformed or unknown payload fields | Drop the field during minimization; keep the event if required fields are present. |
| Client stream -> WebRTC | ICE failure, no peer, WebRTC unsupported | Fall back to WebSocket with the same event contract; expose fallback reason. |
| Client stream -> WebSocket | Socket closes or errors | Reconnect with backoff; buffer up to the retention limit and drop oldest events. |
| Metric exporter -> OTLP collector | Endpoint unset or unreachable | Buffer without transmitting; do not block the UI. |
| Metric exporter -> OTLP collector | Non-20x x response or timeout | Retain batch for the next interval; drop after the buffer limit. |
| Dashboard -> Prometheus | Response exceeds 200 series or 1,000 points/series | Truncate to the caps and surface a truncation indicator. |
| Retention store | Tier capacity exceeded | Evict oldest record in the tier and audit `quota_exceeded`. |
| Retention store | Clock skew or time jump | Use monotonic elapsed time where available; store UTC expiration stamps. |

### Event Lifecycle Example

A wallet sign operation emits the following sequence, which the contract test asserts is well-formed and minimized:

```
task_started   { correlationId: "c1", taskKind: "wallet_sign", state: "started" }
task_completed { correlationId: "c1", taskKind: "wallet_sign", state: "succeeded" }
```

A wallet sign failure emits `task_completed` with `state: "failed"` and a code from the closed enum (for example, `user_rejected`). The correlation ID is opaque and must not be a address, transaction hash, or user identifier.

### Executable Verification

The contract map is verified by `tests/telemetry/contract-map.ts`, which:

1. Asserts that every event type in the matrix has a defined producer and at least one consumer.
2. Asserts that every required field is present on a sample event of that type.
3. Asserts that unknown payload fields are dropped by `reviewAndMinimizeMetadata` without throwing.4. Asserts that consumers ignore unknown fields rather than failing closed.
5. Asserts that the allowed failure behavior for each boundary matches the table above.

Run the verification with:

```
npm test - tests/telemetry/contract-map.ts

```

### Operational Edge Cases for the Contract Map

1. **Producer ships a new optional field without a doc update**: The field is dropped at ingestion by the minimization allowlist until the document and test are updated. No consumer breaks.
2. **Consumer receives an event type it does not know**: The consumer must ignore the event and continue processing. This is the default behavior for the dashboard and the exporter.
3. **WebRTC connection degrades mid-stream**: The client falls back to WebSocket and replays the buffered events up to the retention limit. The event contract is identical on both transports.
4. **OTLP collector returns an error**: The exporter retains the batch for the next interval and drops it after the buffer limit. No event is lost from the local dashboard view.
5. **Retention store evicts a record due to capacity**: An audit record with reason `quota_exceeded` is written so operators can correlate the loss.

### Rollback and Recovery for the Contract Map

- **Rollback a new event type**: Remove the entry from the matrix and the corresponding test case. Producers that still emit the type will have it ignored by consumers.
- **Rollback a new required field**: Revert the producer and consumer changes together. The minimization allowlist will drop the field until the document is updated.
- **Recovery from a broken consumer**: Reload the dashboard or reconnect the stream; no data migration is required because the contract is enforced at ingestion and render time.
