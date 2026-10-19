export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface EditIdentity {
  actorId: string;
  clientId: string;
  operationId: string;
}

export interface EditProposal {
  resourceId: string;
  baseVersion: number;
  baseValue: JsonObject;
  value: JsonObject;
  identity: EditIdentity;
}

export interface VersionedRecord {
  resourceId: string;
  version: number;
  value: JsonObject;
  lastWriter: EditIdentity;
}

export interface ConflictResolutionStore {
  read(resourceId: string): Promise<VersionedRecord | null>;
  compareAndSwap(
    resourceId: string,
    expectedVersion: number,
    value: JsonObject,
    writer: EditIdentity,
  ): Promise<boolean>;
  /**
   * Optional. Version at which `identity` was committed, or `null` if never.
   *
   * Without it, a retried edit is recognised only while it is still the latest
   * writer. Once another client commits on top, a retry whose response was lost
   * merges again from its original base and can resurrect a value that a later
   * edit deliberately replaced. Stores that keep an applied-operation log should
   * implement this so such retries report `already_applied` instead.
   */
  findAppliedVersion?(resourceId: string, identity: EditIdentity): Promise<number | null>;
}

export interface ConflictResolverOptions {
  authorize: (actorId: string, resourceId: string) => boolean | Promise<boolean>;
  maxAttempts?: number;
}

export type ConflictResolutionResult =
  | {
      status: "applied";
      version: number;
      attempts: number;
      retryCount: number;
      conflictPaths: string[];
    }
  | { status: "already_applied"; version: number }
  | { status: "unauthorized"; resourceId: string }
  | { status: "not_found"; resourceId: string }
  | { status: "retry_exhausted"; attempts: number }
  | { status: "invalid_request"; reason: string }
  | { status: "authorization_error"; cause: unknown }
  | { status: "storage_error"; phase: "read" | "compare_and_swap"; cause: unknown };

const MISSING = Symbol("missing");
const MAX_RESOLUTION_ATTEMPTS = 10;
type MaybeJsonValue = JsonValue | typeof MISSING;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;

  seen.add(value);
  let result: string | undefined;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalJson(entry, seen));
    result = entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  } else if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const encoded = canonicalJson(value[key], seen);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      });
    result = entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && canonicalJson(value) !== undefined;
}

function validIdentity(identity: unknown): identity is EditIdentity {
  if (!isRecord(identity)) return false;
  return [identity.actorId, identity.clientId, identity.operationId].every(
    (part) => typeof part === "string" && part.trim().length > 0,
  );
}

function sameValue(left: MaybeJsonValue, right: MaybeJsonValue): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function compareIdentity(left: EditIdentity, right: EditIdentity): number {
  for (const field of ["clientId", "operationId", "actorId"] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function sameIdentity(left: EditIdentity, right: EditIdentity): boolean {
  return compareIdentity(left, right) === 0;
}

function mergeValue(
  base: MaybeJsonValue,
  current: MaybeJsonValue,
  incoming: MaybeJsonValue,
  path: string,
  conflicts: Set<string>,
): MaybeJsonValue {
  if (sameValue(current, incoming)) return current;
  if (sameValue(current, base)) return incoming;
  if (sameValue(incoming, base)) return current;

  if (
    current !== MISSING &&
    incoming !== MISSING &&
    isRecord(current) &&
    isRecord(incoming) &&
    (base === MISSING || isRecord(base))
  ) {
    const baseObject: Record<string, unknown> =
      base === MISSING ? Object.create(null) as Record<string, unknown> : base;
    const result: Record<string, JsonValue> = {};
    const keys = new Set([
      ...Object.keys(baseObject),
      ...Object.keys(current),
      ...Object.keys(incoming),
    ]);

    for (const key of [...keys].sort()) {
      const merged = mergeValue(
        Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] as JsonValue : MISSING,
        Object.prototype.hasOwnProperty.call(current, key) ? current[key] as JsonValue : MISSING,
        Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] as JsonValue : MISSING,
        `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        conflicts,
      );
      if (merged !== MISSING) {
        Object.defineProperty(result, key, {
          value: merged,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  }

  conflicts.add(path || "/");
  const currentOrder = current === MISSING ? "\u0000missing" : canonicalJson(current)!;
  const incomingOrder = incoming === MISSING ? "\u0000missing" : canonicalJson(incoming)!;
  return incomingOrder > currentOrder ? incoming : current;
}

function validVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 0;
}

/**
 * Applies an edit using a deterministic three-way merge and optimistic CAS.
 * Conflicting leaves are won by the lexicographically greater canonical JSON
 * value, independent of arrival order and document-level writer metadata.
 */
export async function resolveEdit(
  proposal: EditProposal,
  store: ConflictResolutionStore,
  options: ConflictResolverOptions,
): Promise<ConflictResolutionResult> {
  if (
    !isRecord(proposal) ||
    typeof proposal.resourceId !== "string" ||
    proposal.resourceId.trim().length === 0 ||
    !validVersion(proposal.baseVersion) ||
    !validIdentity(proposal.identity) ||
    !isJsonObject(proposal.baseValue) ||
    !isJsonObject(proposal.value)
  ) {
    return { status: "invalid_request", reason: "Invalid resource, version, identity, or JSON document." };
  }

  const maxAttempts = options.maxAttempts ?? 3;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_RESOLUTION_ATTEMPTS
  ) {
    return {
      status: "invalid_request",
      reason: `maxAttempts must be between 1 and ${MAX_RESOLUTION_ATTEMPTS}.`,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let authorized: boolean;
    try {
      authorized = await options.authorize(proposal.identity.actorId, proposal.resourceId);
    } catch (cause) {
      return { status: "authorization_error", cause };
    }
    if (!authorized) return { status: "unauthorized", resourceId: proposal.resourceId };

    let current: VersionedRecord | null;
    try {
      current = await store.read(proposal.resourceId);
    } catch (cause) {
      return { status: "storage_error", phase: "read", cause };
    }
    if (!current) return { status: "not_found", resourceId: proposal.resourceId };
    if (
      current.resourceId !== proposal.resourceId ||
      !validVersion(current.version) ||
      !validIdentity(current.lastWriter) ||
      !isJsonObject(current.value)
    ) {
      return { status: "invalid_request", reason: "Store returned an invalid record snapshot." };
    }
    if (proposal.baseVersion > current.version) {
      return { status: "invalid_request", reason: "The proposal is based on a future version." };
    }

    if (sameIdentity(current.lastWriter, proposal.identity)) {
      return { status: "already_applied", version: current.version };
    }

    if (store.findAppliedVersion) {
      let appliedVersion: number | null;
      try {
        appliedVersion = await store.findAppliedVersion(proposal.resourceId, proposal.identity);
      } catch (cause) {
        return { status: "storage_error", phase: "read", cause };
      }
      if (appliedVersion !== null) {
        return { status: "already_applied", version: appliedVersion };
      }
    }

    if (
      proposal.baseVersion === current.version &&
      !sameValue(proposal.baseValue, current.value)
    ) {
      return { status: "invalid_request", reason: "The base document does not match its version." };
    }
    if (current.version === Number.MAX_SAFE_INTEGER) {
      return { status: "invalid_request", reason: "The record version cannot be incremented safely." };
    }

    const conflictPaths = new Set<string>();
    const merged = mergeValue(
      proposal.baseValue,
      current.value,
      proposal.value,
      "",
      conflictPaths,
    );
    if (merged === MISSING || !isJsonObject(merged)) {
      return { status: "invalid_request", reason: "Merge did not produce a valid JSON document." };
    }

    let committed: boolean;
    try {
      committed = await store.compareAndSwap(
        proposal.resourceId,
        current.version,
        merged,
        proposal.identity,
      );
    } catch (cause) {
      return { status: "storage_error", phase: "compare_and_swap", cause };
    }
    if (committed) {
      return {
        status: "applied",
        version: current.version + 1,
        attempts: attempt,
        retryCount: attempt - 1,
        conflictPaths: [...conflictPaths].sort(),
      };
    }
  }

  return { status: "retry_exhausted", attempts: maxAttempts };
}
