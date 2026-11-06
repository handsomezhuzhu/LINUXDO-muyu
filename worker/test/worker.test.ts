import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  clearPlatformKeyCaches,
  encodeBase64Url,
  PlatformAuthError,
  platformKeyId,
  verifyPlatformRequest,
} from "../src/auth";
import { handleRequest } from "../src/index";
import type { Env, MeritState, Wish } from "../src/types";
import { createTestDatabase } from "./d1";

const ISSUER = "https://community.example.test";
const JWKS_URL = `${ISSUER}/mini-app-api/jwks`;
const AUDIENCE = "https://api.example.test";
const APP_ID = "app.muyu.test";
const APP_VERSION = "1.2.3";
const CORS_ORIGIN = "https://app.example.test";
const DAY = "2026-11-06";
let now = 0;
let jtiCounter = 0;
let privateKey: CryptoKey;
let publicKey: CryptoKey;
let kid: string;
let publicJwk: JsonWebKey & { kid?: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: Env;
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

function base64Json(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

async function makeToken(options: {
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signingKey?: CryptoKey;
} = {}): Promise<string> {
  const header = {
    alg: "ES256",
    typ: "mini-app-access+jwt",
    kid,
    ...options.header,
  };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "123456",
    app_id: APP_ID,
    channel: "production",
    version: APP_VERSION,
    scopes: ["network.request"],
    iat: now,
    nbf: now,
    exp: now + 600,
    jti: `test-jti-${String(++jtiCounter).padStart(8, "0")}`,
    htm: "GET",
    htu: `${AUDIENCE}/v1/state`,
    query_keys: ["day"],
    ...options.payload,
  };
  const encodedHeader = base64Json(header);
  const encodedPayload = base64Json(payload);
  const input = encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    options.signingKey ?? privateKey,
    input,
  );
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function verificationOptions(token: string, url = `${AUDIENCE}/v1/state?day=${DAY}`) {
  return {
    authorization: `Bearer ${token}`,
    method: "GET",
    url,
    now,
    PLATFORM_ISSUER: ISSUER,
    PLATFORM_JWKS_URL: JWKS_URL,
    PLATFORM_AUDIENCE: AUDIENCE,
    PLATFORM_APP_ID: APP_ID,
    APP_VERSION,
    CHANNEL: "production" as const,
  };
}

async function api(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    payload?: Record<string, unknown>;
    authenticated?: boolean;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const pathname = new URL(path, AUDIENCE).pathname;
  const payload = {
    htm: method,
    htu: `${AUDIENCE}${pathname}`,
    query_keys: [...new Set(new URL(path, AUDIENCE).searchParams.keys())],
    ...options.payload,
  };
  const headers = new Headers();
  if (options.authenticated !== false) {
    headers.set("Authorization", `Bearer ${await makeToken({ payload })}`);
  }
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return handleRequest(new Request(`${AUDIENCE}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  }), env);
}

function syncBody(overrides: Record<string, unknown> = {}) {
  return {
    batchId: crypto.randomUUID(),
    delta: 1,
    day: DAY,
    dayDelta: 1,
    wishId: null,
    ...overrides,
  };
}

async function sync(overrides: Record<string, unknown> = {}, sub?: string) {
  const response = await api("/v1/merit/sync", {
    method: "POST",
    body: syncBody(overrides),
    ...(sub === undefined ? {} : { payload: { sub } }),
  });
  expect(response.status).toBe(200);
  return await response.json() as MeritState;
}

async function createState(content = "愿测试通过", target = 108, sub?: string): Promise<MeritState> {
  const response = await api("/v1/wishes", {
    method: "POST",
    body: { content, target },
    ...(sub === undefined ? {} : { payload: { sub } }),
  });
  expect(response.status).toBe(201);
  return await response.json() as MeritState;
}

async function create(content = "愿测试通过", target = 108, sub?: string): Promise<Wish> {
  const state = await createState(content, target, sub);
  expect(state.activeWish).not.toBeNull();
  return state.activeWish!;
}

beforeAll(async () => {
  now = Math.floor(Date.now() / 1000);
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  kid = await platformKeyId(publicKey);
  publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
});

beforeEach(async () => {
  clearPlatformKeyCaches();
  fetchCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(JWKS_URL);
    expect(init?.method).toBe("GET");
    fetchCalls += 1;
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  database = await createTestDatabase();
  env = {
    DB: database,
    CHANNEL: "production",
    PLATFORM_ISSUER: ISSUER,
    PLATFORM_JWKS_URL: JWKS_URL,
    PLATFORM_AUDIENCE: AUDIENCE,
    PLATFORM_APP_ID: APP_ID,
    APP_VERSION,
    CORS_ORIGIN,
  };
});

afterEach(() => {
  database.sqlite.close();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("WebCrypto platform authentication", () => {
  test("accepts a signed token and binds the permitted dynamic query", async () => {
    const identity = await verifyPlatformRequest(verificationOptions(await makeToken()));
    expect(identity.iss).toBe(ISSUER);
    expect(identity.sub).toBe("123456");
    expect(identity.scopes).toEqual(["network.request"]);
    expect(identity.query_keys).toEqual(["day"]);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  const rejectedClaims: Array<[string, Record<string, unknown>]> = [
    ["aud", { aud: "https://evil.example.test" }],
    ["app_id", { app_id: "another.app" }],
    ["channel", { channel: "sandbox" }],
    ["version", { version: "9.9.9" }],
    ["method", { htm: "POST" }],
    ["htu", { htu: `${AUDIENCE}/v1/merit/sync` }],
    ["query", { query_keys: [] }],
    ["fixed query", { htu: `${AUDIENCE}/v1/state?fixed=1`, query_keys: ["day"] }],
    ["time", { exp: now - 1 }],
  ];

  for (const [name, payload] of rejectedClaims) {
    test(`rejects a correctly signed token with a tampered ${name}`, async () => {
      const token = await makeToken({ payload });
      await expect(verifyPlatformRequest(verificationOptions(token))).rejects.toBeInstanceOf(PlatformAuthError);
    });
  }

  test("rejects a changed kid and a changed signature", async () => {
    const badKid = await makeToken({ header: { kid: "0".repeat(64) } });
    await expect(verifyPlatformRequest(verificationOptions(badKid))).rejects.toBeInstanceOf(PlatformAuthError);

    const valid = await makeToken();
    const parts = valid.split(".");
    const signature = parts[2]!;
    parts[2] = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    clearPlatformKeyCaches();
    await expect(verifyPlatformRequest(verificationOptions(parts.join(".")))).rejects.toBeInstanceOf(PlatformAuthError);
  });

  test("caches JWKS and does not refetch an unknown kid during cooldown", async () => {
    const token = await makeToken();
    await verifyPlatformRequest(verificationOptions(token));
    await verifyPlatformRequest(verificationOptions(await makeToken()));
    expect(fetchCalls).toBe(1);

    const unknown = await makeToken({ header: { kid: "f".repeat(64) } });
    await expect(verifyPlatformRequest(verificationOptions(unknown))).rejects.toBeInstanceOf(PlatformAuthError);
    expect(fetchCalls).toBe(1);
  });
});

describe("HTTP validation and CORS", () => {
  test("health and OPTIONS do not need JWT, and CORS is fixed", async () => {
    const health = await api("/health", { authenticated: false });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get("Access-Control-Allow-Origin")).toBe(CORS_ORIGIN);

    const preflight = await handleRequest(new Request(`${AUDIENCE}/v1/merit/sync`, {
      method: "OPTIONS",
      headers: { Origin: "https://untrusted.example.test" },
    }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(CORS_ORIGIN);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  test("rejects malformed days and strictly validates sync fields", async () => {
    expect((await api("/v1/state")).status).toBe(400);
    expect((await api("/v1/state?day=2026-02-30")).status).toBe(400);
    expect((await api("/v1/state?day=2026-11-06&extra=1", {
      payload: { query_keys: ["day", "extra"] },
    })).status).toBe(400);

    const badBodies = [
      { ...syncBody(), extra: true },
      { ...syncBody(), delta: 0 },
      { ...syncBody(), delta: 2001 },
      { ...syncBody(), delta: 1.5 },
      { ...syncBody(), batchId: "not-a-uuid" },
      { ...syncBody(), day: "2026-02-29" },
      { ...syncBody(), delta: 2, dayDelta: 1 },
      { ...syncBody(), wishId: "not-a-uuid" },
    ];
    for (const body of badBodies) {
      const response = await api("/v1/merit/sync", { method: "POST", body });
      expect(response.status).toBe(400);
    }
    const state = await sync();
    expect(state.total).toBe(1);
    expect(state.revision).toBe(1);
  });

  test("trims wish text, counts Unicode codepoints, and restricts targets", async () => {
    const eighty = "😀".repeat(80);
    const wish = await create(`  ${eighty}\n`, 1008);
    expect(wish.content).toBe(eighty);
    expect(wish.target).toBe(1008);
    expect(wish.progress).toBe(0);
    expect(wish.id).toMatch(/^[0-9a-f-]{36}$/);

    for (const body of [
        { content: "😀".repeat(81), target: 108 },
        { content: "   ", target: 108 },
        { content: "valid", target: 100 },
        { content: "valid", target: 108, extra: true },
        { content: "\ud800", target: 108 },
      ]) {
      const response = await api("/v1/wishes", { method: "POST", body });
      expect(response.status).toBe(400);
    }
  });
});

describe("D1 transactional merit behavior", () => {
  test("100 replays of one batch count exactly once", async () => {
    const batchId = crypto.randomUUID();
    const first = await sync({ batchId, delta: 7, dayDelta: 7 });
    expect(first.total).toBe(7);
    expect(first.revision).toBe(1);

    const replays = await Promise.all(Array.from({ length: 100 }, () =>
      sync({ batchId, delta: 7, dayDelta: 7 })
    ));
    for (const state of replays) {
      expect(state.total).toBe(7);
      expect(state.today).toBe(7);
      expect(state.revision).toBe(1);
    }
    const rows = database.sqlite.query("SELECT COUNT(*) AS count FROM merit_batches").get() as { count: number };
    expect(rows.count).toBe(1);
  });

  test("concurrent distinct batches lose no increments", async () => {
    const deltas = Array.from({ length: 40 }, (_, index) => index + 1);
    const states = await Promise.all(deltas.map((delta) =>
      sync({ batchId: crypto.randomUUID(), delta, dayDelta: delta })
    ));
    const expected = deltas.reduce((sum, delta) => sum + delta, 0);
    for (const state of states) {
      expect(state.total).toBeLessThanOrEqual(expected);
      expect(state.revision).toBeLessThanOrEqual(40);
    }
    const latest = await api(`/v1/state?day=${DAY}`).then((response) => response.json()) as MeritState;
    expect(latest.total).toBe(expected);
    expect(latest.today).toBe(expected);
    expect(latest.revision).toBe(40);
  });

  test("a replay after later batches returns the latest state without adding merit", async () => {
    const batchId = crypto.randomUUID();
    await sync({ batchId, delta: 3, dayDelta: 3 });
    await sync({ delta: 4, dayDelta: 4 });
    const replay = await sync({ batchId, delta: 3, dayDelta: 3 });
    expect(replay.total).toBe(7);
    expect(replay.today).toBe(7);
    expect(replay.revision).toBe(2);
  });

  test("wish creation returns the complete state", async () => {
    const initial = await createState("首个愿望");
    expect(initial).toEqual({
      revision: 0,
      total: 0,
      today: 0,
      activeWish: expect.objectContaining({
        content: "首个愿望",
        target: 108,
        progress: 0,
        createdAt: expect.any(String),
      }),
      wishes: [],
    });
    const firstWish = initial.activeWish!;

    await sync({ delta: 108, dayDelta: 108, wishId: firstWish.id });
    const next = await createState("后续愿望", 1008);
    expect(next).toEqual({
      revision: 1,
      total: 108,
      today: expect.any(Number),
      activeWish: expect.objectContaining({
        content: "后续愿望",
        target: 1008,
        progress: 0,
        createdAt: expect.any(String),
      }),
      wishes: [expect.objectContaining({
        id: firstWish.id,
        progress: 108,
        completedAt: expect.any(String),
      })],
    });
  });

  test("wish progress is capped and completion happens only once", async () => {
    const wish = await create();
    const partial = await sync({ delta: 100, dayDelta: 100, wishId: wish.id });
    expect(partial.activeWish?.progress).toBe(100);
    expect(partial.activeWish?.completedAt).toBeUndefined();

    const completed = await sync({ delta: 100, dayDelta: 100, wishId: wish.id });
    expect(completed.activeWish).toBeNull();
    expect(completed.wishes.length).toBe(1);
    expect(completed.wishes[0]?.progress).toBe(108);
    expect(completed.wishes[0]?.completedAt).toBeString();
    const completedAt = completed.wishes[0]?.completedAt;

    const later = await sync({ delta: 1, dayDelta: 1, wishId: wish.id });
    expect(later.total).toBe(201);
    expect(later.wishes[0]?.progress).toBe(108);
    expect(later.wishes[0]?.completedAt).toBe(completedAt);
  });

  test("old wish IDs on new batches and replays never advance a new wish", async () => {
    const oldWish = await create("旧愿望");
    const oldBatch = crypto.randomUUID();
    await sync({ batchId: oldBatch, delta: 108, dayDelta: 108, wishId: oldWish.id });
    const currentWish = await create("新愿望");

    const oldIdOnNewBatch = await sync({ delta: 5, dayDelta: 5, wishId: oldWish.id });
    expect(oldIdOnNewBatch.activeWish?.id).toBe(currentWish.id);
    expect(oldIdOnNewBatch.activeWish?.progress).toBe(0);

    const replay = await sync({ batchId: oldBatch, delta: 108, dayDelta: 108, wishId: oldWish.id });
    expect(replay.activeWish?.id).toBe(currentWish.id);
    expect(replay.activeWish?.progress).toBe(0);
    expect(replay.total).toBe(113);
  });

  test("state returns only the five most recent completed wishes", async () => {
    for (let index = 0; index < 6; index += 1) {
      const wish = await create(`完成愿望 ${index}`);
      const state = await sync({ delta: 108, dayDelta: 108, wishId: wish.id });
      expect(state.activeWish).toBeNull();
    }
    const response = await api(`/v1/state?day=${DAY}`);
    expect(response.status).toBe(200);
    const state = await response.json() as MeritState;
    expect(state.wishes.length).toBe(5);
    for (const wish of state.wishes) {
      expect(wish.progress).toBe(108);
      expect(wish.completedAt).toBeString();
    }
    const count = database.sqlite.query("SELECT COUNT(*) AS count FROM wishes").get() as { count: number };
    expect(count.count).toBe(6);
  });

  test("the partial unique index permits only one active wish under concurrency", async () => {
    const responses = await Promise.all([
      api("/v1/wishes", { method: "POST", body: { content: "A", target: 108 } }),
      api("/v1/wishes", { method: "POST", body: { content: "B", target: 1008 } }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const result = database.sqlite.query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM wishes
    `).get() as { total: number; active: number };
    expect(result.total).toBe(1);
    expect(result.active).toBe(1);
  });

  test("all uniqueness and counters are scoped by issuer and subject", async () => {
    const batchId = crypto.randomUUID().toUpperCase();
    await sync({ batchId, delta: 11, dayDelta: 11, wishId: null }, "111");
    await sync({ batchId: batchId.toLowerCase(), delta: 11, dayDelta: 11, wishId: null }, "222");

    const replayNormalized = await sync({
      batchId: batchId.toLowerCase(), delta: 11, dayDelta: 11, wishId: null,
    }, "111");
    expect(replayNormalized.total).toBe(11);
    expect(replayNormalized.revision).toBe(1);

    const second = await api(`/v1/state?day=${DAY}`, { payload: { sub: "222" } });
    const state = await second.json() as MeritState;
    expect(state.total).toBe(11);
    expect(state.revision).toBe(1);
  });

  test("wish creation returns today for the client's local day", async () => {
    await sync({ delta: 7, dayDelta: 7, day: "2026-11-05" });
    const response = await api("/v1/wishes?day=2026-11-05", {
      method: "POST",
      body: { content: "跨时区祈福", target: 108 },
    });
    expect(response.status).toBe(201);
    const state = await response.json() as MeritState;
    expect(state.today).toBe(7);
    expect(state.activeWish?.content).toBe("跨时区祈福");
  });
});
