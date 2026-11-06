import { describe, expect, it } from "bun:test";
import type { HttpRequestOptions, MiniAppSDK } from "@discourse-mini-app/sdk";
import {
  createDiscourseCloudAdapter,
  cloudStorageKey,
} from "../src/discourse-cloud.ts";
import type { ServerState, SyncBatch } from "../src/cloud.ts";

function state(): ServerState {
  return { revision: 0, total: 0, today: 0, activeWish: null, wishes: [] };
}

function mockSdk(overrides: { anonymous?: boolean; status?: number } = {}) {
  const calls: { endpoint: string; options: HttpRequestOptions }[] = [];
  const sdk = {
    ready: Promise.resolve(),
    permissions: { has: () => true },
    user: {
      getCurrent: async () => overrides.anonymous ? null : { id: 42 },
    },
    http: {
      request: async (endpoint: string, options: HttpRequestOptions) => {
        calls.push({ endpoint, options });
        return { status: overrides.status ?? 200, headers: {}, body: state() };
      },
    },
    localStorage: {},
  } as unknown as MiniAppSDK;
  return { sdk, calls };
}

const batch: SyncBatch = {
  batchId: "123e4567-e89b-42d3-a456-426614174000",
  delta: 1,
  day: "2026-11-06",
  dayDelta: 1,
  wishId: null,
};

describe("Discourse cloud adapter wire format", () => {
  it("reads an anonymous user without calling HTTP", async () => {
    const { sdk, calls } = mockSdk({ anonymous: true });
    const adapter = createDiscourseCloudAdapter(sdk);
    expect(await adapter.getLoginUser()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("uses the declared state endpoint and local day query", async () => {
    const { sdk, calls } = mockSdk();
    await createDiscourseCloudAdapter(sdk).getState("2026-11-06");
    expect(calls).toEqual([{ endpoint: "getState", options: { method: "GET", query: { day: "2026-11-06" } } }]);
  });

  it("posts the exact flat sync body expected by Worker", async () => {
    const { sdk, calls } = mockSdk();
    await createDiscourseCloudAdapter(sdk).sync(batch, batch.day);
    expect(calls).toEqual([{ endpoint: "syncMerit", options: { method: "POST", json: { ...batch } } }]);
  });

  it("creates a private wish without extra fields", async () => {
    const { sdk, calls } = mockSdk();
    await createDiscourseCloudAdapter(sdk).createWish("  平安  ", 108, "2026-11-06");
    expect(calls).toEqual([{ endpoint: "createWish", options: { method: "POST", query: { day: "2026-11-06" }, json: { content: "平安", target: 108 } } }]);
  });

  it("maps HTTP authorization failures to a service error", async () => {
    const { sdk } = mockSdk({ status: 401 });
    expect(createDiscourseCloudAdapter(sdk).getState("2026-11-06")).rejects.toMatchObject({ kind: "service" });
  });

  it("keeps missing SDK permissions separate from service rejections", async () => {
    const sdk = {
      ready: Promise.resolve(),
      permissions: { has: () => false },
    } as unknown as MiniAppSDK;
    expect(createDiscourseCloudAdapter(sdk).getLoginUser()).rejects.toMatchObject({ kind: "permission" });
  });

  it("maps an existing active wish to a conflict", async () => {
    const { sdk } = mockSdk({ status: 409 });
    expect(createDiscourseCloudAdapter(sdk).createWish("平安", 108, "2026-11-06")).rejects.toMatchObject({ kind: "active-wish-exists" });
  });

  it("namespaces pending data by community account ID", () => {
    expect(cloudStorageKey(42)).toBe("muyu:cloud:v1:42");
    expect(cloudStorageKey(7)).not.toBe(cloudStorageKey(42));
  });
});
