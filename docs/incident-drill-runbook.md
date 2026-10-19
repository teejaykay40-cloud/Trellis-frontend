# Trellis Incident Drill Runbook

## Overview

The Trellis Frontend Incident Drill Runbook defines formal, repeatable operational procedures and executable verification checks for incident simulation, emergency rollback, safe workflow recovery, domain data validation, and user-impact reporting.

Rather than relying on unverified prose, this runbook is backed by an automated verification harness:

```bash
npm run drill:verify
```

---

## Drill Objectives & Cadence

| Parameter | Specification |
|---|---|
| **Cadence** | Monthly scheduled drill or pre-major deployment gate |
| **Duration** | 30 minutes total execution window |
| **Environment** | Staging / Local isolated test harness (zero production mutation) |
| **Verification Tooling** | `scripts/incident-drill.mjs` and `tests/__tests__/incident-drill.test.ts` |
| **Pass Criteria** | 100% check pass rate with zero unhandled rejections or silent failures |

---

## Core Incident Drill Scenarios

```
┌────────────────────────────────────────────────────────────────────────┐
│                   TRELLIS INCIDENT DRILL ARCHITECTURE                  │
└────────────────────────────────────────────────────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│  SCENARIO 1  │             │  SCENARIO 2  │             │  SCENARIO 3  │
│  Multi-Step  │             │  Emergency   │             │ Domain Data  │
│   Recovery   │             │   Rollback   │             │  Validation  │
└──────────────┘             └──────────────┘             └──────────────┘
       │                            │                            │
       ├─ Checkpoint Fencing        ├─ Snapshot Capture          ├─ Invariant Rules
       ├─ Idempotency Guard         ├─ Checksum Hash Parity      ├─ Field Attribution
       └─ Clean Resumption          └─ Zero Phantom Records      └─ Remediation Hints
                                    │
                                    ▼
                             ┌──────────────┐
                             │  SCENARIO 4  │
                             │ User-Impact  │
                             │  Reporting   │
                             └──────────────┘
                                    │
                                    ├─ Blast Radius Rate
                                    ├─ Error Classification
                                    └─ Status Communications
```

### Scenario 1: Multi-Step Workflow Recovery Drill
* **Incident Profile**: A multi-step transaction (e.g. Agent minting, liquidity provisioning, or batch import) is interrupted mid-execution due to wallet disconnect, browser tab close, or network drop.
* **Failure Induction**: An operation is executed up to step 2 (a side-effect step that writes an on-chain transaction), and fails at step 3 (IPFS metadata upload).
* **Verification Checks**:
  1. The operation enters `status: 'paused'` with recorded error message.
  2. The side-effect step checkpoint (`mint_soroban_agent`) is saved synchronously to the store.
  3. Upon resuming via `execute()`, the recovery engine detects the existing checkpoint and **skips** the side-effect step, guaranteeing that the on-chain mint is NOT executed a second time.
  4. Subsequent steps complete and the operation reaches `status: 'completed'`.

### Scenario 2: Emergency Snapshot Rollback Drill
* **Incident Profile**: An incompatible schema migration or corrupted release causes domain invariants to fail.
* **Failure Induction**: A corrupt state mutation is introduced (e.g. invalid Stellar public key format, illegal status enums, or negative timestamps).
* **Verification Checks**:
  1. Automated invariant monitor flags the corruption and blocks promotion.
  2. The emergency rollback procedure restores state to the pre-incident snapshot.
  3. Cryptographic SHA-256 hash comparison confirms exact byte-for-byte parity with the pre-incident baseline.
  4. All domain invariant checks pass cleanly post-rollback.

### Scenario 3: Domain Data Validation Drill
* **Incident Profile**: Silent data drift in local or remote stores (unparseable dates, orphaned test executions, missing payouts).
* **Verification Checks**:
  1. Baseline healthy fixtures (`healthy-dataset.json`) validate with 0 errors and 0 false positives.
  2. Corrupted test fixtures (`corrupted-dataset.json`) fail deterministically, with every violation mapped to its entity type, entity ID, offending field, and concrete remediation instruction.

### Scenario 4: User-Impact & Blast Radius Reporting Drill
* **Incident Profile**: Upstream RPC degradation (Stellar Horizon 504 Gateway Timeout or Soroban RPC 429 Rate Limiting).
* **Verification Checks**:
  1. Error classifier categorizes failures into transient (retryable with exponential backoff) vs permanent (immediate dead-lettering).
  2. Aggregates blast radius metrics: affected wallets, impacted subsystems, failure rate percentages.
  3. Automatically assigns incident severity (`P1`, `P2`, or `P3`) based on operational health thresholds.
  4. Generates customer-facing announcement text and operator mitigation guidance.

---

## Operational Execution Guide

### 1. Run Complete Incident Drill Suite
To run all drill checks synchronously:
```bash
npm run drill:verify
```

### 2. Run Specific Drill Scenarios
Run targeted scenarios during triage or unit testing:
```bash
# Verify recovery flow and idempotency fencing
node scripts/incident-drill.mjs --scenario recovery

# Verify emergency snapshot rollback
node scripts/incident-drill.mjs --scenario rollback

# Verify invariant validation engine
node scripts/incident-drill.mjs --scenario data-validation

# Verify blast-radius and user-impact reporting
node scripts/incident-drill.mjs --scenario user-impact
```

### 3. Machine-Readable JSON Output
Integrate with CI/CD status monitors or deployment readiness gates:
```bash
npm run drill:verify -- --json
```

### 4. Strict Mode
Treat warnings as failures in pre-release pipelines:
```bash
npm run drill:verify -- --strict
```

### 5. Generate Rare-Path Fixtures
Generate a deterministic synthetic bundle for success, terminal failure, transient retry,
authorization, and partial-side-effect recovery paths:
```bash
node scripts/fixtures/generate-rare-path-fixtures.mjs --seed incident-2026-01
```

The JSON is written to stdout and contains a schema version, stable synthetic operation
IDs, idempotency keys, attempt histories, and expected outcomes. The generator does not
write fixture files, contact services, or mutate application state. Verify the scenario
coverage and invariants with:
```bash
npm run test:rare-path-fixtures
```

Use these fixtures in isolated tests and staging drills only. A changed seed produces
different synthetic IDs; keep a seed fixed when reproducing a reported failure. Never
put real wallet addresses, tokens, signatures, or production payloads in a seed or
fixture. If fixture expectations drift after an intentional contract change, update the
generator and its executable assertions together, and preserve the previous contract
until its consumers have migrated. To roll back an incompatible fixture update, revert
the generator/test change; there are no generated persistent files to clean up.

---

## Operational Edge Cases & Failure Modes

| Edge Case | Failure Mode | Mitigation & Rollback Step |
|---|---|---|
| **Concurrent Browser Tabs** | Two tabs resume the same paused operation simultaneously | `OperationManager` enforces `in_progress` concurrency lock; second tab aborts with `Operation is already in progress` |
| **Corrupted Client Storage** | `localStorage` quota exceeded or corrupted checkpoint data | Checkpoint store falls back to in-memory cache and prompts user to restart operation |
| **Dead-Letter Overflow** | High-cardinality error storm fills queue | Oldest resolved records evicted first; unresolved records tracked with dropped counter alert |
| **Time Skew / Clock Drift** | Client clock behind server causing timestamp reversal | Invariant `LIFE-004` flags negative delta; system aligns to server time header |

---

## Decision Tree: Incident Triage to Recovery

```
Anomaly / Alert Received
  │
  ├─ Is user data or state corrupted?
  │    ├─ YES → Freeze writes & execute Snapshot Rollback (Scenario 2)
  │    └─ NO  → Check RPC and connectivity health
  │
  ├─ Is an operation stuck or interrupted?
  │    ├─ YES → Inspect checkpoint store & trigger Resume (Scenario 1)
  │    └─ NO  → Check for upstream provider rate limits
  │
  ├─ Are transactions failing with 429/5xx?
  │    ├─ YES → Route through Dead-Letter Queue & apply backoff (Scenario 4)
  │    └─ NO  → Verify schema versioning & domain invariants (Scenario 3)
  │
  └─ Invariant violations detected?
       └─ Run `npm run validate:invariants` and review remediation log
```

---

## Post-Drill Evaluation Template

Complete this audit record following each incident drill:

```markdown
## Drill Audit Record
- **Date & Time**: [ISO-8601 Timestamp]
- **Drill Commander**: [Name/Handle]
- **Scenario(s) Tested**: [Recovery / Rollback / Validation / User-Impact]
- **Execution Output**:
  - Total Checks: [N]
  - Passed: [N]
  - Failed: [N]
- **Observed Metrics**:
  - Recovery Resumption Latency: [< 50ms]
  - Rollback Restoration Latency: [< 10ms]
  - Data Validation False Positives: [0]
- **Remediation Items Identified**:
  - [ ] Follow-up task 1
  - [ ] Follow-up task 2
```
