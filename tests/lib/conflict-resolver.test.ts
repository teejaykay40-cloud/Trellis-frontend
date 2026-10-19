import {
  resolveEdit,
  type ConflictResolutionStore,
  type EditIdentity,
  type EditProposal,
  type JsonObject,
  type VersionedRecord,
} from "../../lib/conflict-resolver";

function identity(clientId: string, operationId = "op-1"): EditIdentity {
  return { actorId: `actor-${clientId}`, clientId, operationId };
}

function proposal(
  value: JsonObject,
  editIdentity = identity("client-a"),
  baseValue: JsonObject = { title: "before", settings: { theme: "light" } },
): EditProposal {
  return {
    resourceId: "record-1",
    baseVersion: 1,
    baseValue,
    value,
    identity: editIdentity,
  };
}

function createStore(initial: VersionedRecord): ConflictResolutionStore & { getRecord(): VersionedRecord } {
  let record = initial;
  return {
    getRecord() {
      return record;
    },
    async read() {
      return record;
    },
    async compareAndSwap(resourceId, expectedVersion, value, writer) {
      if (record.resourceId !== resourceId || record.version !== expectedVersion) return false;
      record = { resourceId, version: expectedVersion + 1, value, lastWriter: writer };
      return true;
    },
  };
}

const baseRecord: VersionedRecord = {
  resourceId: "record-1",
  version: 1,
  value: { title: "before", settings: { theme: "light" } },
  lastWriter: identity("origin"),
};

describe("deterministic conflict resolver", () => {
  it("applies an authorized edit and merges non-overlapping fields", async () => {
    const current: VersionedRecord = {
      ...baseRecord,
      version: 2,
      value: { title: "remote", settings: { theme: "light" } },
      lastWriter: identity("client-z"),
    };
    const store = createStore(current);
    const result = await resolveEdit(
      proposal({ title: "before", settings: { theme: "dark" } }),
      store,
      { authorize: () => true },
    );

    expect(result).toMatchObject({
      status: "applied",
      version: 3,
      attempts: 1,
      retryCount: 0,
      conflictPaths: [],
    });
    expect(store.getRecord().value).toEqual({
      title: "remote",
      settings: { theme: "dark" },
    });
  });

  it("chooses the same winner for conflicting leaves regardless of arrival order", async () => {
    const lower = identity("client-a");
    const higher = identity("client-z");
    const lowerFirstStore = createStore(baseRecord);
    const first = await resolveEdit(
      proposal({ title: "from-a", settings: { theme: "light" } }, lower),
      lowerFirstStore,
      { authorize: () => true },
    );
    const second = await resolveEdit(
      proposal({ title: "from-z", settings: { theme: "light" } }, higher),
      lowerFirstStore,
      { authorize: () => true },
    );

    const higherFirstStore = createStore(baseRecord);
    await resolveEdit(
      proposal({ title: "from-z", settings: { theme: "light" } }, higher),
      higherFirstStore,
      { authorize: () => true },
    );
    const reverse = await resolveEdit(
      proposal({ title: "from-a", settings: { theme: "light" } }, lower),
      higherFirstStore,
      { authorize: () => true },
    );

    expect(first.status).toBe("applied");
    expect(second).toMatchObject({ status: "applied", conflictPaths: ["/title"] });
    expect(reverse).toMatchObject({ status: "applied", conflictPaths: ["/title"] });
    expect(lowerFirstStore.getRecord().value).toEqual(higherFirstStore.getRecord().value);
    expect(lowerFirstStore.getRecord().value.title).toBe("from-z");
  });

  it("denies unauthorized actors before reading the record", async () => {
    const store = createStore(baseRecord);
    const read = jest.spyOn(store, "read");
    const result = await resolveEdit(
      proposal({ title: "after", settings: { theme: "light" } }),
      store,
      { authorize: () => false },
    );

    expect(result).toEqual({ status: "unauthorized", resourceId: "record-1" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns authorization failures explicitly", async () => {
    const cause = new Error("authorization service unavailable");
    const result = await resolveEdit(
      proposal({ title: "after", settings: { theme: "light" } }),
      createStore(baseRecord),
      {
        authorize() {
          throw cause;
        },
      },
    );

    expect(result).toEqual({ status: "authorization_error", cause });
  });

  it("recognizes an operation whose successful response was lost", async () => {
    const store = createStore(baseRecord);
    const edit = proposal({ title: "after", settings: { theme: "light" } });
    await resolveEdit(edit, store, { authorize: () => true });

    await expect(
      resolveEdit(edit, store, { authorize: () => true }),
    ).resolves.toEqual({ status: "already_applied", version: 2 });
  });

  it("re-reads and merges after a compare-and-swap race", async () => {
    let record = baseRecord;
    let calls = 0;
    const store: ConflictResolutionStore = {
      async read() {
        return record;
      },
      async compareAndSwap(resourceId, expectedVersion, value, writer) {
        calls += 1;
        if (calls === 1) {
          record = {
            ...record,
            version: 2,
            value: { title: "remote", settings: { theme: "light" } },
            lastWriter: identity("client-z"),
          };
          return false;
        }
        if (record.version !== expectedVersion) return false;
        record = { resourceId, version: expectedVersion + 1, value, lastWriter: writer };
        return true;
      },
    };
    const result = await resolveEdit(
      proposal({ title: "before", settings: { theme: "dark" } }),
      store,
      { authorize: () => true, maxAttempts: 2 },
    );

    expect(result).toMatchObject({ status: "applied", attempts: 2, retryCount: 1 });
    expect(record.value).toEqual({ title: "remote", settings: { theme: "dark" } });
  });

  it("reports exhausted retries and storage failures instead of claiming success", async () => {
    const contendedStore: ConflictResolutionStore = {
      async read() {
        return baseRecord;
      },
      async compareAndSwap() {
        return false;
      },
    };
    await expect(
      resolveEdit(proposal({ title: "after", settings: { theme: "light" } }), contendedStore, {
        authorize: () => true,
        maxAttempts: 2,
      }),
    ).resolves.toEqual({ status: "retry_exhausted", attempts: 2 });

    const storageError = new Error("database unavailable");
    const failingStore: ConflictResolutionStore = {
      async read() {
        throw storageError;
      },
      async compareAndSwap() {
        return false;
      },
    };
    await expect(
      resolveEdit(proposal({ title: "after", settings: { theme: "light" } }), failingStore, {
        authorize: () => true,
      }),
    ).resolves.toEqual({ status: "storage_error", phase: "read", cause: storageError });
  });
});
