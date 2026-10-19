/**
 * In-memory versioned record store for replaying concurrent writes.
 *
 * Implements `ConflictResolutionStore` with atomic compare-and-swap, a commit
 * history, and an applied-operation log. Every call made through a task view
 * ({@link ReplayVersionedStore.forTask}) first yields to the
 * {@link DeterministicScheduler}, so the gap between a read and its CAS is where
 * other tasks get to run.
 *
 * Faults are scripted, not random: "the second CAS by task `a` commits and then
 * loses its response" is a fault plan entry, so the same plan and schedule
 * always produce the same outcome.
 */

import { ApiError } from '@/lib/retry';
import type {
  ConflictResolutionStore,
  EditIdentity,
  JsonObject,
  VersionedRecord,
} from '@/lib/conflict-resolver';
import type { DeterministicScheduler } from './scheduler';

export type StoreOperation = 'read' | 'compareAndSwap' | 'findAppliedVersion';

/**
 * - `unavailable`: the call fails before touching state (HTTP 503).
 * - `lost_response`: the call takes effect, then the caller sees a 503. This is
 *   the uncertain-outcome case that makes retries dangerous.
 */
export type FaultKind = 'unavailable' | 'lost_response';

export interface FaultPlanEntry {
  taskId: string;
  operation: StoreOperation;
  /** 1-based count of this task's calls to `operation`. Omit to fault every call. */
  occurrence?: number;
  kind: FaultKind;
}

export interface CommitRecord {
  version: number;
  writer: EditIdentity;
  value: JsonObject;
}

export interface ReplayStoreOptions {
  scheduler?: DeterministicScheduler;
  faults?: readonly FaultPlanEntry[];
  /**
   * Exposes `findAppliedVersion` to the resolver. Off reproduces a store that
   * only knows its latest writer.
   */
  trackAppliedOperations?: boolean;
}

export function identityKey(identity: EditIdentity): string {
  return [identity.actorId, identity.clientId, identity.operationId].join('\u0000');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function storeUnavailable(operation: StoreOperation): ApiError {
  return new ApiError(`Replay store ${operation} unavailable`, {
    status: 503,
    statusText: 'Service Unavailable',
  });
}

export class ReplayVersionedStore {
  private record: VersionedRecord;
  private readonly commits: CommitRecord[] = [];
  private readonly applied = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private readonly scheduler?: DeterministicScheduler;
  private readonly faults: readonly FaultPlanEntry[];
  private readonly trackApplied: boolean;

  constructor(initial: VersionedRecord, options: ReplayStoreOptions = {}) {
    this.record = clone(initial);
    this.scheduler = options.scheduler;
    this.faults = options.faults ?? [];
    this.trackApplied = options.trackAppliedOperations ?? false;
    this.applied.set(identityKey(initial.lastWriter), initial.version);
  }

  /** Current record, copied so a test cannot mutate store state through it. */
  snapshot(): VersionedRecord {
    return clone(this.record);
  }

  /** Every successful CAS, oldest first. */
  history(): CommitRecord[] {
    return clone(this.commits);
  }

  /** The store as seen by one task: each call yields to the scheduler first. */
  forTask(taskId: string): ConflictResolutionStore {
    const view: ConflictResolutionStore = {
      read: async (resourceId) => {
        const fault = await this.enter(taskId, 'read');
        if (fault === 'unavailable') throw storeUnavailable('read');
        const result = resourceId === this.record.resourceId ? this.snapshot() : null;
        if (fault === 'lost_response') throw storeUnavailable('read');
        return result;
      },
      compareAndSwap: async (resourceId, expectedVersion, value, writer) => {
        const fault = await this.enter(taskId, 'compareAndSwap');
        if (fault === 'unavailable') throw storeUnavailable('compareAndSwap');
        const committed = this.commit(resourceId, expectedVersion, value, writer);
        if (fault === 'lost_response') throw storeUnavailable('compareAndSwap');
        return committed;
      },
    };

    if (this.trackApplied) {
      view.findAppliedVersion = async (resourceId, identity) => {
        const fault = await this.enter(taskId, 'findAppliedVersion');
        if (fault === 'unavailable') throw storeUnavailable('findAppliedVersion');
        const version =
          resourceId === this.record.resourceId ? this.applied.get(identityKey(identity)) ?? null : null;
        if (fault === 'lost_response') throw storeUnavailable('findAppliedVersion');
        return version;
      };
    }
    return view;
  }

  private commit(
    resourceId: string,
    expectedVersion: number,
    value: JsonObject,
    writer: EditIdentity,
  ): boolean {
    if (resourceId !== this.record.resourceId || expectedVersion !== this.record.version) {
      return false;
    }
    const version = expectedVersion + 1;
    this.record = { resourceId, version, value: clone(value), lastWriter: clone(writer) };
    this.commits.push({ version, writer: clone(writer), value: clone(value) });
    this.applied.set(identityKey(writer), version);
    return true;
  }

  private async enter(taskId: string, operation: StoreOperation): Promise<FaultKind | null> {
    const counter = `${taskId}\u0000${operation}`;
    const occurrence = (this.calls.get(counter) ?? 0) + 1;
    this.calls.set(counter, occurrence);
    await this.scheduler?.checkpoint(taskId, operation);
    const fault = this.faults.find(
      (entry) =>
        entry.taskId === taskId &&
        entry.operation === operation &&
        (entry.occurrence === undefined || entry.occurrence === occurrence),
    );
    return fault?.kind ?? null;
  }
}
