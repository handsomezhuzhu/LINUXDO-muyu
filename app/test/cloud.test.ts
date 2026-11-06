import { afterEach, describe, expect, it } from "bun:test";
import {
  CloudError,
  MAX_PENDING_BATCHES,
  cloneServerState,
  createCloudController,
  serializePendingPayload,
  utf8Bytes,
} from "../src/cloud.ts";
import type {
  CloudAdapter,
  CloudController,
  ServerState,
  SyncBatch,
  WishTarget,
} from "../src/cloud.ts";

const DAY = "2026-11-06";
const NOW = new Date(2026, 10, 6, 12, 0, 0);
const now = () => new Date(NOW);
const controllers: CloudController[] = [];

afterEach(async () => {
  while (controllers.length > 0) await controllers.pop()!.dispose();
});

function batch(
  batchId: string,
  delta: number,
  wishId: string | null = null,
): SyncBatch {
  return { batchId, delta, day: DAY, dayDelta: delta, wishId };
}

class FakeAdapter implements CloudAdapter {
  user: { id: number } | null = { id: 7 };
  revision = 0;
  total = 0;
  days: Record<string, number> = {};
  activeWish: ServerState["activeWish"] = null;
  wishes: ServerState["wishes"] = [];
  applied = new Map<string, SyncBatch>();
  saved: string | null = null;
  loadFailure = false;
  corruptCache = false;
  failNextSave = false;
  failNextGet = false;
  failNextSync: "before" | "after" | null = null;
  syncGate: Promise<void> | null = null;
  onSyncStart: (() => void) | null = null;
  nextGetState: ServerState | null = null;
  saveCalls = 0;
  savedValues: string[] = [];
  loadCalls = 0;
  getCalls = 0;
  syncCalls: SyncBatch[] = [];
  createCalls = 0;

  async getLoginUser() {
    return this.user;
  }

  async loadPending(_userId: number) {
    this.loadCalls += 1;
    if (this.loadFailure || this.corruptCache) {
      if (this.loadFailure) throw new Error("storage timeout");
      return "unknown-old-cache";
    }
    return this.saved;
  }

  async savePending(_userId: number, payload: string) {
    this.saveCalls += 1;
    this.savedValues.push(payload);
    if (this.failNextSave) {
      this.failNextSave = false;
      return false;
    }
    this.saved = payload;
    return true;
  }

  private view(day: string): ServerState {
    return cloneServerState({
      revision: this.revision,
      total: this.total,
      today: this.days[day] ?? 0,
      activeWish: this.activeWish,
      wishes: this.wishes,
    });
  }

  async getState(day: string) {
    this.getCalls += 1;
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new CloudError("offline", "read timeout");
    }
    if (this.nextGetState) {
      const response = this.nextGetState;
      this.nextGetState = null;
      return cloneServerState(response);
    }
    return this.view(day);
  }

  private apply(value: SyncBatch): void {
    if (this.applied.has(value.batchId)) return;
    this.applied.set(value.batchId, { ...value });
    this.total += value.delta;
    this.days[value.day] = (this.days[value.day] ?? 0) + value.dayDelta;
    if (this.activeWish && this.activeWish.id === value.wishId) {
      this.activeWish.progress = Math.min(
        this.activeWish.target,
        this.activeWish.progress + value.delta,
      );
      if (this.activeWish.progress === this.activeWish.target) {
        this.wishes = [{
          ...this.activeWish,
          completedAt: "2026-11-06T12:00:00.000Z",
        }, ...this.wishes];
        this.activeWish = null;
      }
    }
    this.revision += 1;
  }

  async sync(value: SyncBatch, day: string) {
    this.syncCalls.push({ ...value });
    this.onSyncStart?.();
    if (this.syncGate) await this.syncGate;
    const failure = this.failNextSync;
    this.failNextSync = null;
    if (failure === "before") throw new Error("offline");
    this.apply(value);
    if (failure === "after") throw new Error("response timeout");
    return this.view(day);
  }

  async createWish(content: string, target: WishTarget, day: string) {
    this.createCalls += 1;
    if (this.activeWish) throw new CloudError("active-wish-exists");
    this.activeWish = {
      id: `wish-${this.createCalls}`,
      content,
      target,
      progress: 0,
      createdAt: "2026-11-06T12:00:00.000Z",
    };
    this.revision += 1;
    return this.view(day);
  }
}

function controller(adapter: FakeAdapter): CloudController {
  const value = createCloudController(adapter, { now, autoFlush: false });
  controllers.push(value);
  return value;
}

async function ready(adapter = new FakeAdapter()) {
  const value = controller(adapter);
  expect(await value.initialize()).toEqual({ status: "ready" });
  return value;
}

describe("cloud initialization and cache safety", () => {
  it("requires login before reading the outbox or cloud", async () => {
    const adapter = new FakeAdapter();
    adapter.user = null;
    const cloud = controller(adapter);
    expect(await cloud.initialize()).toEqual({ status: "login-required" });
    expect(adapter.loadCalls).toBe(0);
    expect(adapter.getCalls).toBe(0);
    expect(cloud.recordHit().accepted).toBe(false);
  });

  it("never overwrites an unreadable or corrupt unknown cache", async () => {
    for (const failure of ["loadFailure", "corruptCache"] as const) {
      const adapter = new FakeAdapter();
      adapter[failure] = true;
      const cloud = controller(adapter);
      expect(await cloud.initialize()).toEqual({ status: "cache-error" });
      expect(adapter.getCalls).toBe(0);
      expect(adapter.saveCalls).toBe(0);
      expect(cloud.recordHit().accepted).toBe(false);
      expect(await cloud.flush()).toBe(false);
      expect(adapter.saveCalls).toBe(0);
    }
  });

  it("replays pending and current in order before enabling hits", async () => {
    const adapter = new FakeAdapter();
    adapter.total = 20;
    adapter.days[DAY] = 20;
    adapter.saved = serializePendingPayload({
      schemaVersion: 1,
      pending: [batch("old-a", 2), batch("old-b", 1)],
      current: batch("old-c", 2),
      sound: false,
    });
    let beginSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      beginSync = resolve;
    });
    let releaseSync!: () => void;
    adapter.syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    adapter.onSyncStart = beginSync;

    const cloud = controller(adapter);
    const initialization = cloud.initialize();
    await syncStarted;
    expect(cloud.recordHit().accepted).toBe(false);
    releaseSync();
    adapter.onSyncStart = null;
    expect(await initialization).toEqual({ status: "ready" });
    expect(adapter.syncCalls.map((value) => value.batchId)).toEqual([
      "old-a",
      "old-b",
      "old-c",
    ]);
    expect(cloud.getState()).toMatchObject({
      total: 25,
      today: 25,
      sound: false,
      revision: 3,
    });
    expect(JSON.parse(adapter.saved!)).toMatchObject({
      pending: [],
      current: null,
    });
    expect(cloud.recordHit().accepted).toBe(true);
  });
});

describe("cloud outbox retries", () => {
  it("retries the same frozen batch after commit-response timeout without duplication", async () => {
    const adapter = new FakeAdapter();
    const cloud = await ready(adapter);
    for (let index = 0; index < 3; index += 1) {
      expect(cloud.recordHit().accepted).toBe(true);
    }
    adapter.failNextSync = "after";
    expect(await cloud.flush()).toBe(false);
    expect(adapter.total).toBe(3);
    expect(cloud.getState().total).toBe(3);
    expect(cloud.recordHit().accepted).toBe(false);

    expect(await cloud.flush()).toBe(true);
    expect(adapter.syncCalls.map((value) => value.batchId)).toEqual([
      adapter.syncCalls[0]!.batchId,
      adapter.syncCalls[0]!.batchId,
    ]);
    expect(adapter.total).toBe(3);
    expect(adapter.revision).toBe(1);
    expect(cloud.recordHit().accepted).toBe(true);
    expect(cloud.getState().total).toBe(4);
  });

  it("rejects new hits after an offline failure and recovers without losing counts", async () => {
    const adapter = new FakeAdapter();
    const cloud = await ready(adapter);
    cloud.recordHit();
    cloud.recordHit();
    adapter.failNextSync = "before";
    expect(await cloud.flush()).toBe(false);
    expect(adapter.total).toBe(0);
    expect(cloud.getState().total).toBe(2);
    expect(cloud.recordHit().accepted).toBe(false);
    expect(await cloud.flush()).toBe(true);
    expect(adapter.total).toBe(2);
    expect(cloud.recordHit().accepted).toBe(true);
    expect(await cloud.flush()).toBe(true);
    expect(adapter.total).toBe(3);
  });

  it("does not roll numbers back for a stale revision or a failed read", async () => {
    const adapter = new FakeAdapter();
    adapter.revision = 10;
    adapter.total = 100;
    adapter.days[DAY] = 100;
    const cloud = await ready(adapter);
    adapter.nextGetState = {
      revision: 9,
      total: 1,
      today: 1,
      activeWish: null,
      wishes: [],
    };
    expect(await cloud.refresh()).toBe(true);
    expect(cloud.getState()).toMatchObject({ revision: 10, total: 100, today: 100 });
    adapter.failNextGet = true;
    expect(await cloud.refresh()).toBe(false);
    expect(cloud.getState()).toMatchObject({ revision: 10, total: 100, today: 100 });
  });

  it("enforces a finite outbox and always stores at most 4 KiB", async () => {
    const adapter = new FakeAdapter();
    adapter.activeWish = {
      id: "w".repeat(128),
      content: "平安",
      target: 10080,
      progress: 0,
      createdAt: "2026-11-06T00:00:00.000Z",
    };
    const cloud = await ready(adapter);
    const limit = MAX_PENDING_BATCHES * 2000;
    let accepted = 0;
    for (let index = 0; index < limit; index += 1) {
      if (cloud.recordHit().accepted) accepted += 1;
    }
    expect(accepted).toBe(limit);
    const rejected = cloud.recordHit();
    expect(rejected.accepted).toBe(false);
    expect(rejected.state.total).toBe(limit);
    expect(await cloud.flush()).toBe(true);
    expect(adapter.total).toBe(limit);
    expect(adapter.syncCalls).toHaveLength(MAX_PENDING_BATCHES);
    for (const saved of adapter.savedValues) {
      expect(utf8Bytes(saved)).toBeLessThanOrEqual(4096);
    }
    expect(cloud.recordHit().accepted).toBe(true);
  }, 15000);
});

describe("cloud wishes", () => {
  it("flushes old non-wish batches first, completes once, caps progress and creates one active wish", async () => {
    const adapter = new FakeAdapter();
    const cloud = await ready(adapter);
    for (let index = 0; index < 5; index += 1) cloud.recordHit();

    const created = await cloud.createWish("  平安😀  ", 108);
    expect(created.ok).toBe(true);
    expect(created.state.activeWish).toMatchObject({
      content: "平安😀",
      progress: 0,
      target: 108,
    });
    expect(adapter.syncCalls[0]!.wishId).toBeNull();
    expect(adapter.activeWish?.progress).toBe(0);
    expect(adapter.total).toBe(5);

    const duplicate = await cloud.createWish("另一个", 108);
    expect(duplicate).toMatchObject({ ok: false, status: "active-wish-exists" });
    expect(adapter.createCalls).toBe(1);

    let completions = 0;
    for (let index = 0; index < 120; index += 1) {
      const hit = cloud.recordHit();
      expect(hit.accepted).toBe(true);
      if (hit.completedWish) {
        completions += 1;
        expect(hit.completedWish.progress).toBe(108);
        expect(hit.state.justReachedTarget).toBe(true);
      }
    }
    expect(completions).toBe(1);
    expect(cloud.getState().activeWish?.progress).toBe(108);
    expect(cloud.getState().wishes).toHaveLength(0);

    expect(await cloud.flush()).toBe(true);
    expect(cloud.getState().activeWish).toBeNull();
    expect(cloud.getState().wishes).toHaveLength(1);
    expect(cloud.getState().wishes[0]).toMatchObject({
      progress: 108,
      target: 108,
      completedAt: "2026-11-06T12:00:00.000Z",
    });
    expect(adapter.total).toBe(125);

    const next = await cloud.createWish("新的祈愿", 1008);
    expect(next.ok).toBe(true);
    expect(next.state.activeWish?.progress).toBe(0);
    expect(adapter.createCalls).toBe(2);
  });

  it("validates Unicode code points, trimming and allowed targets", async () => {
    const adapter = new FakeAdapter();
    const cloud = await ready(adapter);
    for (const content of ["", "   ", "😀".repeat(81)]) {
      expect(await cloud.createWish(content, 108)).toMatchObject({
        ok: false,
        status: "invalid-input",
      });
    }
    expect(await cloud.createWish("valid", 123 as WishTarget)).toMatchObject({
      ok: false,
      status: "invalid-input",
    });
    expect(adapter.createCalls).toBe(0);
    const valid = await cloud.createWish(`  ${"😀".repeat(80)}  `, 108);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(Array.from(valid.wish.content)).toHaveLength(80);
    }
    expect(adapter.createCalls).toBe(1);
  });
});
