/**
 * Deterministic replay harness for concurrent writes and retries.
 *
 * Test-support code: nothing in the app imports it. See
 * `docs/concurrent-write-replay.md` for how to write and replay a scenario.
 */

export {
  DeterministicScheduler,
  ReplayDivergenceError,
  scheduleFromTrace,
  type ReplayRun,
  type ReplayStep,
  type SchedulerOptions,
} from './scheduler';

export {
  ReplayVersionedStore,
  identityKey,
  storeUnavailable,
  type CommitRecord,
  type FaultKind,
  type FaultPlanEntry,
  type ReplayStoreOptions,
  type StoreOperation,
} from './versioned-store';
