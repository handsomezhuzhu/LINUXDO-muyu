import { describe, expect, it } from "bun:test";
import type { MiniAppSDK, Permission } from "@discourse-mini-app/sdk";
import { createHost } from "../src/host.ts";
import { defaultState } from "../src/merit.ts";

function makeSdk(options: {
  read?: boolean;
  write?: boolean;
  initial?: string | null;
  failRead?: boolean;
  failFirstWrite?: boolean;
}) {
  let stored = options.initial ?? null;
  let writeCalls = 0;
  const permissions = new Set<Permission>();
  if (options.read !== false) permissions.add("storage.read");
  if (options.write !== false) permissions.add("storage.write");
  const sdk = {
    ready: Promise.resolve(),
    permissions: { has: (permission: Permission) => permissions.has(permission) },
    localStorage: {
      async getItem() {
        if (options.failRead) throw new Error("TIMEOUT");
        return stored;
      },
      async setItem(_key: string, value: string) {
        writeCalls += 1;
        if (options.failFirstWrite && writeCalls === 1) {
          throw new Error("RATE_LIMIT");
        }
        stored = value;
        return null;
      },
    },
  } as unknown as MiniAppSDK;
  return {
    sdk,
    writes: () => writeCalls,
    stored: () => stored,
  };
}

function callbacks() {
  return {
    onTheme: () => undefined,
    onNotice: () => undefined,
    onStorageError: () => undefined,
  };
}

describe("host storage safety", () => {
  it("does not write before restoration completes or when reading fails", async () => {
    const mock = makeSdk({ initial: "old-record", failRead: true });
    const host = createHost(mock.sdk, callbacks());
    host.save(defaultState());
    const result = await host.connect();
    expect(result).toEqual({ ok: false, value: null });
    host.save(defaultState());
    await host.flush();
    expect(mock.writes()).toBe(0);
    expect(mock.stored()).toBe("old-record");
    await host.dispose();
  });

  it("never enables write-only access without a successful read", async () => {
    const mock = makeSdk({ read: false, write: true, initial: "old-record" });
    const host = createHost(mock.sdk, callbacks());
    const result = await host.connect();
    expect(result.ok).toBe(false);
    host.save(defaultState());
    await host.flush();
    expect(mock.writes()).toBe(0);
    await host.dispose();
  });

  it("allows a new record only after a confirmed missing key", async () => {
    const mock = makeSdk({ initial: null });
    const host = createHost(mock.sdk, callbacks());
    expect(await host.connect()).toEqual({ ok: true, value: null });
    host.save(defaultState());
    await host.flush();
    expect(mock.writes()).toBe(1);
    expect(JSON.parse(mock.stored()!).total).toBe(0);
    await host.dispose();
  });

  it("retains a failed snapshot and retries it", async () => {
    const mock = makeSdk({ initial: null, failFirstWrite: true });
    const host = createHost(mock.sdk, callbacks());
    await host.connect();
    const state = { ...defaultState(), total: 7, today: 7 };
    host.save(state);
    await host.flush();
    expect(mock.writes()).toBe(1);
    expect(mock.stored()).toBeNull();
    await host.flush();
    expect(mock.writes()).toBe(2);
    expect(JSON.parse(mock.stored()!).total).toBe(7);
    await host.dispose();
  });

  it("flushes the pending snapshot during explicit disposal", async () => {
    const mock = makeSdk({ initial: null });
    const host = createHost(mock.sdk, callbacks());
    await host.connect();
    host.save({ ...defaultState(), total: 12, today: 12 });
    await host.dispose();
    expect(mock.writes()).toBe(1);
    expect(JSON.parse(mock.stored()!).total).toBe(12);
    host.save(defaultState());
    await host.flush();
    expect(mock.writes()).toBe(1);
  });
});
