/**
 * Trellis Projection Reconciliation Engine
 *
 * Orchestrates drift detection, root-cause reporting, dry-run-first repair
 * planning, digest-verified repair execution, post-repair verification, and
 * rollback snapshot recovery.
 */

import { createHash } from 'node:crypto';
import {
  applyOperationToProjection,
  reconcileAffiliateLedger,
  reconcileReferralClickMetrics,
  reconcileSearchIndex,
  reconcileTelemetryCounters,
} from './reconcilers';
import {
  PROJECTION_DOMAINS,
  type ApplyReconciliationRepairOptions,
  type DriftFinding,
  type DriftKind,
  type DriftSeverity,
  type ProjectionDomain,
  type ProjectionStoreAdapter,
  type RepairAuthorization,
  type RepairJobCheckpoint,
  type RepairJobCheckpointStore,
  type ReconciliationJobStatus,
  type ReconciliationProjectionState,
  type ReconciliationReport,
  type ReconciliationSourceState,
  type ReconciliationSummary,
  type RepairOperation,
  type RepairPlan,
  type RollbackSnapshot,
  type RunReconciliationOptions,
} from './types';

export type ReconciliationErrorCode =
  | 'DRY_RUN_REQUIRED'
  | 'REPAIR_UNAUTHORIZED'
  | 'PLAN_STALE_STATE_CHANGED'
  | 'UNKNOWN_DOMAIN'
  | 'ROLLBACK_INVALID_SNAPSHOT'
  | 'JOB_ALREADY_EXISTS'
  | 'JOB_NOT_FOUND'
  | 'JOB_CHECKPOINT_INVALID'
  | 'JOB_STALE_STATE_CHANGED';

export class ReconciliationRepairError extends Error {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode, message: string) {
    super(message);
    this.name = 'ReconciliationRepairError';
    this.code = code;
  }
}

/** Deep-clones a JSON-serializable state object so dry-runs never mutate caller inputs. */
export function cloneState<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deterministic canonical JSON serialization with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${pairs.join(',')}}`;
}

/** Computes a SHA-256 hex digest of a canonicalized value. */
export function computeStateFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Computes a cryptographic digest binding source state, projection state, and planned repair operations. */
export function computePlanDigest(
  sourceFingerprint: string,
  projectionFingerprint: string,
  operations: readonly RepairOperation[],
): string {
  return computeStateFingerprint({
    sourceFingerprint,
    projectionFingerprint,
    operations,
  });
}

/** In-memory `ProjectionStoreAdapter` with snapshot/restore support. */
export function createMemoryProjectionStore(
  initialState: ReconciliationProjectionState = {},
): ProjectionStoreAdapter & { getState(): ReconciliationProjectionState } {
  let state = cloneState(initialState);
  return {
    readProjection() {
      return cloneState(state);
    },
    writeProjection(nextState: ReconciliationProjectionState) {
      state = cloneState(nextState);
    },
    getState() {
      return cloneState(state);
    },
  };
}

function resolveDomains(requested?: readonly ProjectionDomain[]): ProjectionDomain[] {
  if (!requested || requested.length === 0) {
    return [...PROJECTION_DOMAINS];
  }
  for (const domain of requested) {
    if (!PROJECTION_DOMAINS.includes(domain)) {
      throw new ReconciliationRepairError(
        'UNKNOWN_DOMAIN',
        `Unknown reconciliation domain '${domain}'. Valid domains: ${PROJECTION_DOMAINS.join(', ')}`,
      );
    }
  }
  return Array.from(new Set(requested));
}

function buildSummary(
  domains: readonly ProjectionDomain[],
  recordsCompared: number,
  findings: readonly DriftFinding[],
  repairedCount: number,
  skippedCount: number,
  failedCount: number,
): ReconciliationSummary {
  const bySeverity: Record<DriftSeverity, number> = {
    critical: 0,
    error: 0,
    warning: 0,
  };
  const byKind: Record<DriftKind, number> = {
    missing_projection: 0,
    orphaned_projection: 0,
    value_mismatch: 0,
    visibility_mismatch: 0,
    stale_watermark: 0,
  };
  const byDomain: Record<ProjectionDomain, number> = {
    'affiliate-ledger': 0,
    'referral-click-metrics': 0,
    'search-index': 0,
    'telemetry-counters': 0,
  };

  let repairableCount = 0;
  let manualReviewCount = 0;

  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byKind[finding.kind] += 1;
    byDomain[finding.domain] += 1;
    if (finding.repairable) repairableCount += 1;
    else manualReviewCount += 1;
  }

  async function requireRepairAuthorization(authorize?: RepairAuthorization): Promise<void> {
    if (!authorize || !(await authorize())) {
      throw new ReconciliationRepairError(
        'REPAIR_UNAUTHORIZED',
        'Repair authorization was not granted. No projection changes were made.',
      );
    }
  }

  return {
    domainsEvaluated: domains,
    recordsCompared,
    driftedCount: findings.length,
    repairableCount,
    manualReviewCount,
    repairedCount,
    skippedCount,
    failedCount,
    bySeverity,
    byKind,
    byDomain,
  };
}

/**
 * Executes a non-mutating reconciliation dry-run comparing `source` state
 * against `projection` state.
 *
 * Detects drift, attaches root-cause hints to every finding, and produces a
 * digest-verified `RepairPlan` that can be passed to `applyReconciliationRepair`.
 */
export function runReconciliation(
  source: ReconciliationSourceState,
  projection: ReconciliationProjectionState,
  options: RunReconciliationOptions = {},
): ReconciliationReport {
  const domains = resolveDomains(options.domains);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const tolerance = options.numericTolerance ?? 0.01;

  // Clone inputs to guarantee dry-run purity
  const safeSource = cloneState(source ?? {});
  const safeProjection = cloneState(projection ?? {});

  const findings: DriftFinding[] = [];
  const operations: RepairOperation[] = [];
  let recordsCompared = 0;

  for (const domain of domains) {
    if (domain === 'affiliate-ledger') {
      const res = reconcileAffiliateLedger(safeSource, safeProjection, tolerance);
      recordsCompared += res.recordsCompared;
      findings.push(...res.findings);
      operations.push(...res.operations);
    } else if (domain === 'referral-click-metrics') {
      const res = reconcileReferralClickMetrics(safeSource, safeProjection, tolerance);
      recordsCompared += res.recordsCompared;
      findings.push(...res.findings);
      operations.push(...res.operations);
    } else if (domain === 'search-index') {
      const res = reconcileSearchIndex(safeSource, safeProjection);
      recordsCompared += res.recordsCompared;
      findings.push(...res.findings);
      operations.push(...res.operations);
    } else if (domain === 'telemetry-counters') {
      const res = reconcileTelemetryCounters(safeSource, safeProjection);
      recordsCompared += res.recordsCompared;
      findings.push(...res.findings);
      operations.push(...res.operations);
    }
  }

  const sourceFingerprint = computeStateFingerprint(safeSource);
  const projectionFingerprint = computeStateFingerprint(safeProjection);
  const planDigest = computePlanDigest(sourceFingerprint, projectionFingerprint, operations);
  const jobId = options.jobId ?? `recon-${planDigest.slice(0, 12)}`;

  const repairPlan: RepairPlan = {
    planId: `plan-${planDigest.slice(0, 12)}`,
    createdAt: nowIso,
    sourceFingerprint,
    projectionFingerprint,
    planDigest,
    operations,
    manualReviewFindings: findings.filter((f) => !f.repairable),
  };

  const summary = buildSummary(
    domains,
    recordsCompared,
    findings,
    0,
    operations.length,
    0,
  );

  const status: ReconciliationJobStatus =
    findings.length === 0 ? 'clean' : 'drift_detected';

  return {
    jobId,
    timestamp: nowIso,
    mode: 'dry-run',
    ok: findings.length === 0,
    status,
    summary,
    findings,
    repairPlan,
    errors: [],
  };
}

/**
 * Applies planned repairs to a `ProjectionStoreAdapter` following a strict
 * dry-run-first workflow:
 * 1. Verifies that a valid `approvedPlan` (or `planDigest`) from a prior dry-run
 *    was supplied (unless `requireDryRunApproval: false`).
 * 2. Re-runs dry-run reconciliation against the current state and verifies that
 *    neither the source state nor the projection state has drifted since the
 *    dry-run plan was produced.
 * 3. Captures a deep-cloned `RollbackSnapshot` before mutating the projection.
 * 4. Applies repair operations and persists the updated projection.
 * 5. Runs a post-repair reconciliation pass to verify that all repairable drift
 *    has been eliminated.
 */
export async function applyReconciliationRepair(
  source: ReconciliationSourceState,
  store: ProjectionStoreAdapter,
  options: ApplyReconciliationRepairOptions = {},
): Promise<ReconciliationReport> {
  await requireRepairAuthorization(options.authorize);
  const requireApproval = options.requireDryRunApproval !== false;
  if (requireApproval && !options.approvedPlan) {
    throw new ReconciliationRepairError(
      'DRY_RUN_REQUIRED',
      'Refusing to apply reconciliation repairs without a prior dry-run approval. Run runReconciliation() first and pass its repairPlan (or planDigest) as approvedPlan.',
    );
  }

  const currentProjection = await store.readProjection();
  const currentDryRun = runReconciliation(source, currentProjection, options);
  const nowIso = options.nowIso ?? new Date().toISOString();

  if (options.approvedPlan) {
    const expectedDigest =
      typeof options.approvedPlan === 'string'
        ? options.approvedPlan
        : options.approvedPlan.planDigest;

    if (expectedDigest !== currentDryRun.repairPlan.planDigest) {
      throw new ReconciliationRepairError(
        'PLAN_STALE_STATE_CHANGED',
        `Approved dry-run plan digest (${expectedDigest.slice(0, 12)}) does not match current state digest (${currentDryRun.repairPlan.planDigest.slice(0, 12)}). Re-run dry-run reconciliation before applying repairs.`,
      );
    }
  }

  const rollbackSnapshot: RollbackSnapshot = {
    snapshotId: `rb-${currentDryRun.repairPlan.planDigest.slice(0, 12)}`,
    planId: currentDryRun.repairPlan.planId,
    planDigest: currentDryRun.repairPlan.planDigest,
    capturedAt: nowIso,
    projectionBefore: cloneState(currentProjection),
  };

  const workingProjection = cloneState(currentProjection);
  const filterSet =
    options.onlyFindingIds && options.onlyFindingIds.length > 0
      ? new Set(options.onlyFindingIds)
      : null;

  let repairedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const op of currentDryRun.repairPlan.operations) {
    if (filterSet && !filterSet.has(op.findingId)) {
      skippedCount += 1;
      continue;
    }
    try {
      applyOperationToProjection(workingProjection, op);
      repairedCount += 1;
    } catch (error) {
      failedCount += 1;
      errors.push(
        `Failed to apply repair for ${op.findingId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failedCount === 0 && repairedCount > 0) {
    await store.writeProjection(workingProjection);
  }

  const postProjection = await store.readProjection();
  const postRun = runReconciliation(source, postProjection, {
    ...options,
    domains: currentDryRun.summary.domainsEvaluated,
  });
  const remainingRepairable = postRun.findings.filter((f) => f.repairable).length;
  const verifiedClean =
    failedCount === 0 &&
    (filterSet ? postRun.findings.filter((f) => filterSet.has(f.id)).length === 0 : remainingRepairable === 0);

  let status: ReconciliationJobStatus;
  if (failedCount > 0) {
    status = 'failed';
  } else if (currentDryRun.findings.length === 0) {
    status = 'clean';
  } else if (postRun.findings.length === 0) {
    status = 'repaired';
  } else {
    status = 'partially_repaired';
  }

  const summary = buildSummary(
    currentDryRun.summary.domainsEvaluated,
    currentDryRun.summary.recordsCompared,
    currentDryRun.findings,
    repairedCount,
    skippedCount + currentDryRun.summary.manualReviewCount,
    failedCount,
  );

  return {
    jobId: options.jobId ?? currentDryRun.jobId,
    timestamp: nowIso,
    mode: 'apply',
    ok: failedCount === 0 && postRun.findings.length === 0,
    status,
    summary,
    findings: currentDryRun.findings,
    repairPlan: currentDryRun.repairPlan,
    rollbackSnapshot,
    postRepairVerification: {
      verifiedClean,
      remainingDriftCount: postRun.findings.length,
      remainingRepairableCount: remainingRepairable,
      remainingFindings: postRun.findings,
    },
    errors,
  };
}

/**
 * Two-phase dry-run-first reconciliation helper:
 * Phase 1: Executes `runReconciliation` (dry-run) to detect drift and build a `RepairPlan`.
 * Phase 2: If `apply: true` and repairable operations exist, executes `applyReconciliationRepair`
 *          using the dry-run `repairPlan` for digest verification.
 */
export async function reconcileAndRepair(
  source: ReconciliationSourceState,
  store: ProjectionStoreAdapter,
  options: RunReconciliationOptions & {
    apply?: boolean;
    onlyFindingIds?: readonly string[];
    authorize?: RepairAuthorization;
  } = {},
): Promise<{ dryRunReport: ReconciliationReport; applyReport?: ReconciliationReport }> {
  const initialProjection = await store.readProjection();
  const dryRunReport = runReconciliation(source, initialProjection, options);

  if (!options.apply || dryRunReport.repairPlan.operations.length === 0) {
    return { dryRunReport };
  }

  const applyReport = await applyReconciliationRepair(source, store, {
    ...options,
    approvedPlan: dryRunReport.repairPlan,
    requireDryRunApproval: true,
  });

  return { dryRunReport, applyReport };
}

  function checkpointProjectionAt(
    checkpoint: RepairJobCheckpoint,
    operationCount: number,
  ): ReconciliationProjectionState {
    const expected = cloneState(checkpoint.rollbackSnapshot.projectionBefore);
    for (const operation of checkpoint.operationsToApply.slice(0, operationCount)) {
      applyOperationToProjection(expected, operation);
    }
    return expected;
  }

  function isValidCheckpoint(checkpoint: RepairJobCheckpoint, jobId: string): boolean {
    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      !checkpoint.plan ||
      !Array.isArray(checkpoint.plan.operations) ||
      !Array.isArray(checkpoint.operationsToApply) ||
      !Array.isArray(checkpoint.domains) ||
      !Array.isArray(checkpoint.errors) ||
      !checkpoint.rollbackSnapshot ||
      !checkpoint.rollbackSnapshot.projectionBefore ||
      !checkpoint.projectionState ||
      !['running', 'failed', 'completed'].includes(checkpoint.status)
    ) {
      return false;
    }
    return (
      checkpoint.version === 1 &&
      checkpoint.jobId === jobId &&
      checkpoint.domains.length > 0 &&
      checkpoint.domains.every((domain) => PROJECTION_DOMAINS.includes(domain)) &&
      checkpoint.plan.planDigest ===
        computePlanDigest(
          checkpoint.plan.sourceFingerprint,
          checkpoint.plan.projectionFingerprint,
          checkpoint.plan.operations,
        ) &&
      checkpoint.sourceFingerprint === checkpoint.plan.sourceFingerprint &&
      computeStateFingerprint(checkpoint.rollbackSnapshot.projectionBefore) ===
        checkpoint.plan.projectionFingerprint &&
      canonicalJson(checkpoint.operationsToApply) ===
        canonicalJson(
          checkpoint.plan.operations.filter((operation) =>
            checkpoint.operationsToApply.some((selected) => selected.findingId === operation.findingId),
          ),
        ) &&
      Number.isInteger(checkpoint.nextOperationIndex) &&
      checkpoint.nextOperationIndex >= 0 &&
      checkpoint.nextOperationIndex <= checkpoint.operationsToApply.length &&
      checkpoint.rollbackSnapshot.planDigest === checkpoint.plan.planDigest
    );
  }

  function buildResumableReport(
    source: ReconciliationSourceState,
    projection: ReconciliationProjectionState,
    checkpoint: RepairJobCheckpoint,
    options: RunReconciliationOptions,
    failedCount: number,
  ): ReconciliationReport {
    const reportOptions = { ...options, domains: checkpoint.domains };
    const postRun = runReconciliation(source, projection, reportOptions);
    const initialRun = runReconciliation(
      source,
      checkpoint.rollbackSnapshot.projectionBefore,
      reportOptions,
    );
    const remainingRepairable = postRun.findings.filter((finding) => finding.repairable).length;
    const wasFiltered = checkpoint.operationsToApply.length !== checkpoint.plan.operations.length;
    const verifiedClean =
      failedCount === 0 &&
      (wasFiltered
        ? postRun.findings.filter((finding) =>
            checkpoint.operationsToApply.some((operation) => operation.findingId === finding.id),
          ).length === 0
        : remainingRepairable === 0);
    const status: ReconciliationJobStatus =
      failedCount > 0
        ? 'failed'
        : postRun.findings.length === 0
          ? checkpoint.plan.operations.length === 0
            ? 'clean'
            : 'repaired'
          : 'partially_repaired';
    const summary = buildSummary(
      initialRun.summary.domainsEvaluated,
      initialRun.summary.recordsCompared,
      initialRun.findings,
      checkpoint.nextOperationIndex,
      checkpoint.plan.operations.length - checkpoint.operationsToApply.length +
        (checkpoint.plan.manualReviewFindings.length),
      failedCount,
    );

    return {
      jobId: checkpoint.jobId,
      timestamp: options.nowIso ?? new Date().toISOString(),
      mode: 'apply',
      ok: failedCount === 0 && postRun.findings.length === 0,
      status,
      summary,
      findings: initialRun.findings,
      repairPlan: checkpoint.plan,
      rollbackSnapshot: checkpoint.rollbackSnapshot,
      postRepairVerification: {
        verifiedClean,
        remainingDriftCount: postRun.findings.length,
        remainingRepairableCount: remainingRepairable,
        remainingFindings: postRun.findings,
      },
      errors: checkpoint.errors,
    };
  }

  async function executeResumableRepairJob(
    source: ReconciliationSourceState,
    store: ProjectionStoreAdapter,
    checkpointStore: RepairJobCheckpointStore,
    checkpoint: RepairJobCheckpoint,
    options: ApplyReconciliationRepairOptions,
  ): Promise<ReconciliationReport> {
    const currentSourceFingerprint = computeStateFingerprint(source);
    if (currentSourceFingerprint !== checkpoint.sourceFingerprint) {
      throw new ReconciliationRepairError(
        'JOB_STALE_STATE_CHANGED',
        'The authoritative source changed since this repair job was approved. Create a fresh dry-run before retrying.',
      );
    }
    const approvedPlan = runReconciliation(
      source,
      checkpoint.rollbackSnapshot.projectionBefore,
      { domains: checkpoint.domains },
    );
    if (approvedPlan.repairPlan.planDigest !== checkpoint.plan.planDigest) {
      throw new ReconciliationRepairError(
        'JOB_CHECKPOINT_INVALID',
        'The saved repair plan does not match the source and original projection recorded in its checkpoint.',
      );
    }

    let currentProjection = await store.readProjection();
    let expectedProjection = checkpointProjectionAt(checkpoint, checkpoint.nextOperationIndex);
    if (computeStateFingerprint(currentProjection) !== computeStateFingerprint(expectedProjection)) {
      const operationAfterCheckpoint =
        checkpoint.operationsToApply[checkpoint.nextOperationIndex];
      if (!operationAfterCheckpoint) {
        throw new ReconciliationRepairError(
          'JOB_STALE_STATE_CHANGED',
          'Projection state no longer matches the completed repair checkpoint.',
        );
      }
      expectedProjection = checkpointProjectionAt(checkpoint, checkpoint.nextOperationIndex + 1);
      if (computeStateFingerprint(currentProjection) !== computeStateFingerprint(expectedProjection)) {
        throw new ReconciliationRepairError(
          'JOB_STALE_STATE_CHANGED',
          'Projection state no longer matches this repair job or its last in-flight operation.',
        );
      }
      checkpoint.nextOperationIndex += 1;
      checkpoint.projectionState = cloneState(currentProjection);
      checkpoint.status = 'running';
      checkpoint.errors = [];
      checkpoint.updatedAt = options.nowIso ?? new Date().toISOString();
      await checkpointStore.writeCheckpoint(checkpoint);
    }

    checkpoint.status = 'running';
    checkpoint.errors = [];
    checkpoint.updatedAt = options.nowIso ?? new Date().toISOString();
    await checkpointStore.writeCheckpoint(checkpoint);

    let failedCount = 0;
    for (let index = checkpoint.nextOperationIndex; index < checkpoint.operationsToApply.length; index += 1) {
      try {
        currentProjection = cloneState(await store.readProjection());
        if (
          computeStateFingerprint(currentProjection) !==
          computeStateFingerprint(checkpoint.projectionState)
        ) {
          throw new ReconciliationRepairError(
            'JOB_STALE_STATE_CHANGED',
            'Projection state changed while the repair job was running; no further operations were applied.',
          );
        }
        applyOperationToProjection(currentProjection, checkpoint.operationsToApply[index]);
        await store.writeProjection(currentProjection);
        checkpoint.nextOperationIndex = index + 1;
        checkpoint.projectionState = cloneState(currentProjection);
        checkpoint.updatedAt = options.nowIso ?? new Date().toISOString();
        await checkpointStore.writeCheckpoint(checkpoint);
      } catch (error) {
        failedCount = 1;
        const message = `Repair operation ${checkpoint.operationsToApply[index].findingId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        checkpoint.status = 'failed';
        checkpoint.errors = [...checkpoint.errors, message];
        checkpoint.projectionState = cloneState(await store.readProjection());
        checkpoint.updatedAt = options.nowIso ?? new Date().toISOString();
        await checkpointStore.writeCheckpoint(checkpoint);
        break;
      }
    }

    currentProjection = await store.readProjection();
    if (failedCount === 0) {
      checkpoint.status = 'completed';
      checkpoint.projectionState = cloneState(currentProjection);
      checkpoint.updatedAt = options.nowIso ?? new Date().toISOString();
      await checkpointStore.writeCheckpoint(checkpoint);
    }
    return buildResumableReport(source, currentProjection, checkpoint, options, failedCount);
  }

  /** Creates and executes an authorized, digest-approved repair job with durable progress checkpoints. */
  export async function startResumableRepairJob(
    source: ReconciliationSourceState,
    store: ProjectionStoreAdapter,
    checkpointStore: RepairJobCheckpointStore,
    options: ApplyReconciliationRepairOptions & { jobId: string },
  ): Promise<ReconciliationReport> {
    await requireRepairAuthorization(options.authorize);
    if (await checkpointStore.readCheckpoint(options.jobId)) {
      throw new ReconciliationRepairError(
        'JOB_ALREADY_EXISTS',
        `Repair job '${options.jobId}' already exists. Resume it instead of replacing its checkpoint.`,
      );
    }
    const projection = await store.readProjection();
    const dryRun = runReconciliation(source, projection, options);
    const requireApproval = options.requireDryRunApproval !== false;
    if (requireApproval && !options.approvedPlan) {
      throw new ReconciliationRepairError(
        'DRY_RUN_REQUIRED',
        'Refusing to start a repair job without a prior dry-run approval.',
      );
    }
    if (options.approvedPlan) {
      const approvedDigest =
        typeof options.approvedPlan === 'string'
          ? options.approvedPlan
          : options.approvedPlan.planDigest;
      if (approvedDigest !== dryRun.repairPlan.planDigest) {
        throw new ReconciliationRepairError(
          'PLAN_STALE_STATE_CHANGED',
          'The approved dry-run digest does not match the current source and projection state.',
        );
      }
    }
    const selectedFindings = options.onlyFindingIds
      ? new Set(options.onlyFindingIds)
      : null;
    const operationsToApply = dryRun.repairPlan.operations.filter(
      (operation) => !selectedFindings || selectedFindings.has(operation.findingId),
    );
    const timestamp = options.nowIso ?? new Date().toISOString();
    const checkpoint: RepairJobCheckpoint = {
      version: 1,
      jobId: options.jobId,
      domains: dryRun.summary.domainsEvaluated,
      plan: dryRun.repairPlan,
      sourceFingerprint: dryRun.repairPlan.sourceFingerprint,
      operationsToApply,
      nextOperationIndex: 0,
      projectionState: cloneState(projection),
      rollbackSnapshot: {
        snapshotId: `rb-${dryRun.repairPlan.planDigest.slice(0, 12)}`,
        planId: dryRun.repairPlan.planId,
        planDigest: dryRun.repairPlan.planDigest,
        capturedAt: timestamp,
        projectionBefore: cloneState(projection),
      },
      status: 'running',
      errors: [],
      updatedAt: timestamp,
    };
    await checkpointStore.writeCheckpoint(checkpoint);
    return executeResumableRepairJob(source, store, checkpointStore, checkpoint, options);
  }

  /** Resumes an interrupted or failed repair job after re-authorizing and validating its checkpoint. */
  export async function resumeResumableRepairJob(
    source: ReconciliationSourceState,
    store: ProjectionStoreAdapter,
    checkpointStore: RepairJobCheckpointStore,
    options: ApplyReconciliationRepairOptions & { jobId: string },
  ): Promise<ReconciliationReport> {
    await requireRepairAuthorization(options.authorize);
    const checkpoint = await checkpointStore.readCheckpoint(options.jobId);
    if (!checkpoint) {
      throw new ReconciliationRepairError(
        'JOB_NOT_FOUND',
        `No repair checkpoint exists for job '${options.jobId}'.`,
      );
    }
    if (!isValidCheckpoint(checkpoint, options.jobId)) {
      throw new ReconciliationRepairError(
        'JOB_CHECKPOINT_INVALID',
        `Repair checkpoint for job '${options.jobId}' is invalid or corrupted.`,
      );
    }
    return executeResumableRepairJob(source, store, checkpointStore, checkpoint, options);
  }

/**
 * Restores a `ProjectionStoreAdapter` from a `RollbackSnapshot` captured prior
 * to `applyReconciliationRepair`.
 */
export async function rollbackReconciliationRepair(
  store: ProjectionStoreAdapter,
  snapshot: RollbackSnapshot,
  authorize?: RepairAuthorization,
): Promise<ReconciliationProjectionState> {
  await requireRepairAuthorization(authorize);
  if (!snapshot || !snapshot.projectionBefore || !snapshot.snapshotId) {
    throw new ReconciliationRepairError(
      'ROLLBACK_INVALID_SNAPSHOT',
      'Invalid rollback snapshot: missing snapshotId or projectionBefore state.',
    );
  }
  const restored = cloneState(snapshot.projectionBefore);
  await store.writeProjection(restored);
  return restored;
}

/** Formats a `ReconciliationReport` as human-readable operator text. */
export function renderReconciliationTextReport(report: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`Trellis Projection Reconciliation Report (${report.mode.toUpperCase()})`);
  lines.push(`Job ID:     ${report.jobId}`);
  lines.push(`Timestamp:  ${report.timestamp}`);
  lines.push(`Status:     ${report.status.toUpperCase()} (ok=${report.ok})`);
  lines.push(`Plan Digest: ${report.repairPlan.planDigest}`);
  lines.push(
    `Summary:    ${report.summary.recordsCompared} compared | ${report.summary.driftedCount} drifted (${report.summary.repairableCount} repairable, ${report.summary.manualReviewCount} manual review) | ${report.summary.repairedCount} repaired`,
  );

  if (report.findings.length > 0) {
    lines.push('\nDetected Drift Findings:');
    for (const f of report.findings) {
      lines.push(
        `  - [${f.severity.toUpperCase()}] ${f.id} (${f.kind}) -> action: ${f.plannedAction}`,
      );
      lines.push(`    Message:    ${f.message}`);
      lines.push(
        `    Root Cause: [${f.rootCauseHint.code}] ${f.rootCauseHint.summary}`,
      );
      lines.push(`    Remediation: ${f.rootCauseHint.recommendedAction}`);
    }
  } else {
    lines.push('\nZero projection drift detected.');
  }

  if (report.postRepairVerification) {
    lines.push(
      `\nPost-Repair Verification: clean=${report.postRepairVerification.verifiedClean}, remainingDrift=${report.postRepairVerification.remainingDriftCount}`,
    );
  }

  return lines.join('\n');
}
