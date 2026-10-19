/**
 * Deterministic interleaving of concurrent async tasks.
 *
 * Why this exists: concurrent-write bugs live in the gaps between a read and a
 * compare-and-swap, or between a failed attempt and its retry. Real timers and
 * real I/O pick one interleaving per run, so a race that fails once in a
 * thousand CI runs cannot be reproduced on demand. This scheduler makes the
 * interleaving an input instead of an accident.
 *
 * How: every task runs until it calls {@link DeterministicScheduler.checkpoint}
 * (a store read, a CAS, a backoff sleep...). When no task is runnable, the
 * scheduler releases exactly one waiting task, chosen either from an explicit
 * schedule or from a seeded PRNG. Each release is recorded in a trace, and that
 * trace's task ids are themselves a schedule, so any run — including a failing
 * seed found by a sweep — can be replayed step for step.
 *
 * Constraint: tasks must only await checkpoints or promises that settle in the
 * microtask queue. A task awaiting a real timer stalls the run until the timer
 * fires, which still terminates but stops being deterministic.
 */

import { seededRandom } from '@/lib/sandbox-wallet';

export interface ReplayStep {
  /** Zero-based release index. */
  index: number;
  taskId: string;
  /** What the task is about to do, e.g. `read`, `compareAndSwap`, `backoff`. */
  label: string;
}

export interface SchedulerOptions {
  /** PRNG seed used to pick the next task once `schedule` is exhausted. */
  seed?: number;
  /** Task ids to release, in order. Takes precedence over the seed. */
  schedule?: readonly string[];
  /** Upper bound on releases, so a livelocked run fails instead of hanging. */
  maxSteps?: number;
}

export interface ReplayRun<T> {
  results: Record<string, PromiseSettledResult<T>>;
  trace: ReplayStep[];
}

/** A scripted schedule named a task that was not waiting at that step. */
export class ReplayDivergenceError extends Error {
  readonly step: number;
  readonly expected: string;
  readonly waiting: string[];

  constructor(step: number, expected: string, waiting: string[]) {
    super(
      `Replay diverged at step ${step}: schedule expected "${expected}" but waiting tasks were [${waiting.join(', ')}]`,
    );
    this.name = 'ReplayDivergenceError';
    this.step = step;
    this.expected = expected;
    this.waiting = waiting;
  }
}

const DEFAULT_MAX_STEPS = 10_000;

interface Waiter {
  label: string;
  release: () => void;
}

export class DeterministicScheduler {
  private readonly random: () => number;
  private readonly schedule: readonly string[];
  private readonly maxSteps: number;
  private readonly waiting = new Map<string, Waiter>();
  private readonly trace: ReplayStep[] = [];
  private runnable = 0;
  private running = false;
  private onQuiescent: (() => void) | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.random = seededRandom(options.seed ?? 1);
    this.schedule = options.schedule ?? [];
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  /**
   * Suspends `taskId` until the scheduler picks it. Outside {@link run} it is a
   * no-op, so the same store or sleep can be used in an ordinary test.
   */
  checkpoint(taskId: string, label: string): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.waiting.has(taskId)) {
      throw new Error(`Task "${taskId}" reached a checkpoint while already waiting at one`);
    }
    return new Promise<void>((release) => {
      this.waiting.set(taskId, { label, release });
      this.runnable -= 1;
      this.notify();
    });
  }

  /** A `sleep` for `executeWithRetry` that yields instead of waiting on a timer. */
  sleepFor(taskId: string): (ms: number) => Promise<void> {
    return (ms) => this.checkpoint(taskId, `backoff:${ms}`);
  }

  /** Runs every task to completion under the configured interleaving. */
  async run<T>(tasks: Record<string, () => Promise<T>>): Promise<ReplayRun<T>> {
    if (this.running) throw new Error('DeterministicScheduler.run is not re-entrant');
    // Sorted so the PRNG sees tasks in an order that does not depend on how the
    // caller happened to write the object literal.
    const ids = Object.keys(tasks).sort();
    const results: Record<string, PromiseSettledResult<T>> = {};

    this.running = true;
    this.runnable = ids.length;
    try {
      const settled = ids.map(async (id) => {
        try {
          results[id] = { status: 'fulfilled', value: await tasks[id]() };
        } catch (reason) {
          results[id] = { status: 'rejected', reason };
        } finally {
          this.runnable -= 1;
          this.notify();
        }
      });

      for (;;) {
        await this.quiescent();
        if (this.waiting.size === 0) break;
        if (this.trace.length >= this.maxSteps) {
          throw new Error(`Replay exceeded ${this.maxSteps} steps; tasks may be livelocked`);
        }
        this.releaseNext();
      }

      await Promise.all(settled);
      return { results, trace: [...this.trace] };
    } finally {
      this.running = false;
    }
  }

  private releaseNext(): void {
    const index = this.trace.length;
    const waitingIds = [...this.waiting.keys()].sort();
    let taskId: string;
    if (index < this.schedule.length) {
      taskId = this.schedule[index];
      if (!this.waiting.has(taskId)) {
        throw new ReplayDivergenceError(index, taskId, waitingIds);
      }
    } else {
      taskId = waitingIds[Math.floor(this.random() * waitingIds.length)];
    }

    const waiter = this.waiting.get(taskId)!;
    this.waiting.delete(taskId);
    this.trace.push({ index, taskId, label: waiter.label });
    this.runnable += 1;
    waiter.release();
  }

  private quiescent(): Promise<void> {
    if (this.runnable === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.onQuiescent = resolve;
    });
  }

  private notify(): void {
    if (this.runnable === 0 && this.onQuiescent) {
      const resolve = this.onQuiescent;
      this.onQuiescent = null;
      resolve();
    }
  }
}

/** The task ids of a trace, in order — feed back as `schedule` to replay it. */
export function scheduleFromTrace(trace: readonly ReplayStep[]): string[] {
  return trace.map((step) => step.taskId);
}
