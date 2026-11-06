import { dateKey } from "./merit.ts";
import type { AppState } from "./merit.ts";

export const CLOUD_SCHEMA_VERSION = 1;
export const CLOUD_STORAGE_VALUE_LIMIT = 4096;
export const MAX_BATCH_DELTA = 2000;
export const MAX_PENDING_BATCHES = 16;

export type WishTarget = 108 | 1008 | 10080;

export interface Wish {
  id: string;
  content: string;
  target: WishTarget;
  progress: number;
  createdAt: string;
  completedAt?: string;
}

export interface ServerState {
  revision: number;
  total: number;
  today: number;
  activeWish: Wish | null;
  wishes: Wish[];
}

export interface SyncBatch {
  batchId: string;
  delta: number;
  day: string;
  dayDelta: number;
  wishId: string | null;
}

export interface CloudState extends AppState {
  revision: number;
  activeWish: Wish | null;
  wishes: Wish[];
  justReachedTarget: boolean;
}

export interface PendingPayload {
  schemaVersion: 1;
  pending: SyncBatch[];
  current: SyncBatch | null;
  sound: boolean;
}

export type CloudErrorKind =
  | "offline"
  | "permission"
  | "cache"
  | "invalid-response"
  | "active-wish-exists";

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string = kind,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

export interface CloudAdapter {
  getLoginUser(): Promise<{ id: number } | null>;
  loadPending(userId: number): Promise<string | null>;
  savePending(userId: number, payload: string): Promise<boolean>;
  getState(day: string): Promise<ServerState>;
  sync(batch: SyncBatch, day: string): Promise<ServerState>;
  createWish(
    content: string,
    target: WishTarget,
    day: string,
  ): Promise<ServerState>;
}

export type InitializeStatus =
  | "ready"
  | "login-required"
  | "permission-required"
  | "offline"
  | "cache-error";

export type CreateWishResult =
  | { ok: true; status: "created"; state: CloudState; wish: Wish }
  | {
      ok: false;
      status:
        | "invalid-input"
        | "not-ready"
        | "sync-failed"
        | "active-wish-exists"
        | "create-failed";
      state: CloudState;
    };

export interface CloudController {
  initialize(): Promise<{ status: InitializeStatus }>;
  getState(): CloudState;
  recordHit(now?: Date): {
    accepted: boolean;
    state: CloudState;
    completedWish?: Wish;
  };
  flush(): Promise<boolean>;
  refresh(): Promise<boolean>;
  setSound(enabled: boolean): void;
  createWish(content: string, target: WishTarget): Promise<CreateWishResult>;
  dispose(): Promise<void>;
}

export interface CloudControllerOptions {
  now?: () => Date;
  autoFlush?: boolean;
  flushDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isWishTarget(value: unknown): value is WishTarget {
  return value === 108 || value === 1008 || value === 10080;
}

export function normalizeWishInput(
  content: unknown,
  target: unknown,
): { content: string; target: WishTarget } | null {
  if (typeof content !== "string" || !isWishTarget(target)) return null;
  const trimmed = content.trim();
  const length = Array.from(trimmed).length;
  return length >= 1 && length <= 80
    ? { content: trimmed, target }
    : null;
}

function parseWish(value: unknown): Wish {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    typeof value.content !== "string" ||
    value.content !== value.content.trim() ||
    Array.from(value.content).length < 1 ||
    Array.from(value.content).length > 80 ||
    !isWishTarget(value.target) ||
    !isCount(value.progress) ||
    value.progress > value.target ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length < 1 ||
    value.createdAt.length > 64 ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== "string" ||
        value.completedAt.length < 1 ||
        value.completedAt.length > 64))
  ) {
    throw new CloudError("invalid-response", "Invalid wish");
  }
  return {
    id: value.id,
    content: value.content,
    target: value.target,
    progress: value.progress,
    createdAt: value.createdAt,
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: value.completedAt }),
  };
}

export function cloneWish(wish: Wish): Wish {
  return { ...wish };
}

export function cloneServerState(state: ServerState): ServerState {
  return {
    revision: state.revision,
    total: state.total,
    today: state.today,
    activeWish: state.activeWish ? cloneWish(state.activeWish) : null,
    wishes: state.wishes.map(cloneWish),
  };
}

export function parseServerState(value: unknown): ServerState {
  if (
    !isRecord(value) ||
    !isCount(value.revision) ||
    !isCount(value.total) ||
    !isCount(value.today) ||
    !Array.isArray(value.wishes) ||
    value.wishes.length > 500
  ) {
    throw new CloudError("invalid-response", "Invalid server state");
  }
  const activeWish = value.activeWish === null
    ? null
    : parseWish(value.activeWish);
  const wishes = value.wishes.map(parseWish);
  const ids = new Set(wishes.map((wish) => wish.id));
  if (
    ids.size !== wishes.length ||
    (activeWish !== null && ids.has(activeWish.id))
  ) {
    throw new CloudError("invalid-response", "Duplicate wish id");
  }
  return {
    revision: value.revision,
    total: value.total,
    today: value.today,
    activeWish,
    wishes,
  };
}

export function parseSyncBatch(value: unknown): SyncBatch {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    value.batchId.length < 1 ||
    value.batchId.length > 80 ||
    !isCount(value.delta) ||
    value.delta < 1 ||
    value.delta > MAX_BATCH_DELTA ||
    !isDay(value.day) ||
    !isCount(value.dayDelta) ||
    value.dayDelta < 1 ||
    value.dayDelta > value.delta ||
    (value.wishId !== null &&
      (typeof value.wishId !== "string" ||
        value.wishId.length < 1 ||
        value.wishId.length > 128))
  ) {
    throw new CloudError("cache", "Invalid sync batch");
  }
  return {
    batchId: value.batchId,
    delta: value.delta,
    day: value.day,
    dayDelta: value.dayDelta,
    wishId: value.wishId,
  };
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function serializePendingPayload(payload: PendingPayload): string {
  const serialized = JSON.stringify(payload);
  if (utf8Bytes(serialized) > CLOUD_STORAGE_VALUE_LIMIT) {
    throw new CloudError("cache", "Pending payload exceeds 4 KiB");
  }
  return serialized;
}

export function parsePendingPayload(serialized: string | null): PendingPayload {
  if (serialized === null) {
    return {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      pending: [],
      current: null,
      sound: true,
    };
  }
  try {
    if (utf8Bytes(serialized) > CLOUD_STORAGE_VALUE_LIMIT) {
      throw new Error("too large");
    }
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.schemaVersion !== CLOUD_SCHEMA_VERSION ||
      !Array.isArray(value.pending) ||
      value.pending.length > MAX_PENDING_BATCHES ||
      typeof value.sound !== "boolean"
    ) {
      throw new Error("invalid payload");
    }
    const pending = value.pending.map(parseSyncBatch);
    const current = value.current === null ? null : parseSyncBatch(value.current);
    if (current !== null && pending.length >= MAX_PENDING_BATCHES) {
      throw new Error("too many batches");
    }
    const ids = new Set(pending.map((batch) => batch.batchId));
    if (
      ids.size !== pending.length ||
      (current !== null && ids.has(current.batchId)) ||
      utf8Bytes(
        serializePendingPayload({
          schemaVersion: CLOUD_SCHEMA_VERSION,
          pending,
          current,
          sound: value.sound,
        }),
      ) > CLOUD_STORAGE_VALUE_LIMIT
    ) {
      throw new Error("invalid or oversized payload");
    }
    return {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      pending,
      current,
      sound: value.sound,
    };
  } catch (error) {
    if (error instanceof CloudError && error.kind === "cache") throw error;
    throw new CloudError("cache", "Invalid pending payload");
  }
}

function emptyServerState(): ServerState {
  return {
    revision: 0,
    total: 0,
    today: 0,
    activeWish: null,
    wishes: [],
  };
}

function addClamped(left: number, right: number): number {
  return left >= Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

function newBatchId(): string {
  return globalThis.crypto.randomUUID();
}

function cloneBatch(batch: SyncBatch): SyncBatch {
  return { ...batch };
}

export function createCloudController(
  adapter: CloudAdapter,
  options: CloudControllerOptions = {},
): CloudController {
  const now = options.now ?? (() => new Date());
  const autoFlush = options.autoFlush !== false;
  const flushDelayMs = options.flushDelayMs ?? 4000;

  let server = emptyServerState();
  let serverDay = dateKey(now());
  let pending: SyncBatch[] = [];
  let current: SyncBatch | null = null;
  let sound = true;
  let justReachedTarget = false;
  let state: CloudState;

  let userId: number | null = null;
  let ready = false;
  let accepting = false;
  let cacheWritable = false;
  let cacheDirty = false;
  let suspended = false;
  let disposing = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let initialization: Promise<{ status: InitializeStatus }> | null = null;
  let tail: Promise<void> = Promise.resolve();
  let lastFlushError: "cache" | "offline" | "permission" = "offline";

  function recompute(): void {
    const batches = current === null ? pending : [...pending, current];
    let total = server.total;
    let today = serverDay === (state?.day ?? serverDay) ? server.today : 0;
    let activeWish = server.activeWish ? cloneWish(server.activeWish) : null;
    for (const batch of batches) {
      total = addClamped(total, batch.delta);
      if (batch.day === (state?.day ?? serverDay)) {
        today = addClamped(today, batch.dayDelta);
      }
      if (activeWish !== null && batch.wishId === activeWish.id) {
        activeWish.progress = Math.min(
          activeWish.target,
          addClamped(activeWish.progress, batch.delta),
        );
      }
    }
    state = {
      version: 1,
      total,
      day: state?.day ?? serverDay,
      today,
      sound,
      revision: server.revision,
      activeWish,
      wishes: server.wishes.map(cloneWish),
      justReachedTarget,
    };
  }

  state = {
    version: 1,
    total: 0,
    day: serverDay,
    today: 0,
    sound,
    revision: 0,
    activeWish: null,
    wishes: [],
    justReachedTarget: false,
  };

  function getState(): CloudState {
    return {
      ...state,
      activeWish: state.activeWish ? cloneWish(state.activeWish) : null,
      wishes: state.wishes.map(cloneWish),
    };
  }

  function rollDay(): void {
    const day = dateKey(now());
    if (day !== state.day) {
      state.day = day;
      justReachedTarget = false;
      recompute();
    }
  }

  function outboxPayload(): PendingPayload {
    return {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      pending: pending.map(cloneBatch),
      current: current === null ? null : cloneBatch(current),
      sound,
    };
  }

  function payloadFits(payload: PendingPayload): boolean {
    try {
      serializePendingPayload(payload);
      return payload.pending.length <= MAX_PENDING_BATCHES &&
        (payload.current === null ||
          payload.pending.length < MAX_PENDING_BATCHES);
    } catch {
      return false;
    }
  }

  async function persist(): Promise<boolean> {
    if (!cacheWritable || userId === null) return false;
    try {
      const serialized = serializePendingPayload(outboxPayload());
      if (!(await adapter.savePending(userId, serialized))) {
        lastFlushError = "cache";
        cacheDirty = true;
        return false;
      }
      cacheDirty = false;
      return true;
    } catch {
      lastFlushError = "cache";
      cacheDirty = true;
      return false;
    }
  }

  function freezeCurrent(): boolean {
    if (current === null) return true;
    const candidate = {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      pending: [...pending.map(cloneBatch), cloneBatch(current)],
      current: null,
      sound,
    } satisfies PendingPayload;
    if (!payloadFits(candidate)) return false;
    pending.push(current);
    current = null;
    cacheDirty = true;
    return true;
  }

  function applyResponse(
    responseValue: unknown,
    responseDay: string,
    acknowledgedBatchId?: string,
  ): void {
    const response = parseServerState(responseValue);
    if (acknowledgedBatchId !== undefined) {
      const index = pending.findIndex(
        (batch) => batch.batchId === acknowledgedBatchId,
      );
      if (index < 0) {
        throw new CloudError("invalid-response", "Unknown acknowledged batch");
      }
      pending.splice(index, 1);
      cacheDirty = true;
    }
    if (response.revision >= server.revision) {
      server = cloneServerState(response);
      serverDay = responseDay;
    }
    justReachedTarget = false;
    recompute();
  }

  function scheduleFlush(): void {
    if (
      !autoFlush ||
      timer !== null ||
      disposed ||
      disposing ||
      !ready ||
      !accepting
    ) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushDelayMs);
  }

  function clearFlushTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function flushInternal(): Promise<boolean> {
    if (userId === null || !cacheWritable) return false;
    rollDay();
    if (!freezeCurrent()) {
      accepting = false;
      lastFlushError = "cache";
      return false;
    }
    if (cacheDirty && !(await persist())) {
      accepting = false;
      return false;
    }
    while (pending.length > 0) {
      const batch = pending[0]!;
      const responseDay = state.day;
      let response: ServerState;
      try {
        // The exact frozen object, including its batchId, is retained on errors.
        response = await adapter.sync(batch, responseDay);
        applyResponse(response, responseDay, batch.batchId);
      } catch (error) {
        lastFlushError = error instanceof CloudError &&
            error.kind === "permission"
          ? "permission"
          : "offline";
        accepting = false;
        recompute();
        return false;
      }
      // Persist each acknowledgement before submitting the next batch.
      if (!(await persist())) {
        accepting = false;
        recompute();
        return false;
      }
    }
    if (cacheDirty && !(await persist())) {
      accepting = false;
      return false;
    }
    if (!disposed && !disposing) accepting = ready;
    recompute();
    return true;
  }

  async function initializeAttempt(): Promise<{ status: InitializeStatus }> {
    ready = false;
    accepting = false;
    clearFlushTimer();
    if (disposed || disposing) return { status: "offline" };

    let login: { id: number } | null;
    try {
      login = await adapter.getLoginUser();
    } catch (error) {
      return {
        status: error instanceof CloudError && error.kind === "permission"
          ? "permission-required"
          : "offline",
      };
    }
    if (
      login === null ||
      !Number.isSafeInteger(login.id) ||
      login.id <= 0
    ) {
      return { status: "login-required" };
    }
    userId = login.id;

    let restored: PendingPayload;
    cacheWritable = false;
    try {
      restored = parsePendingPayload(await adapter.loadPending(userId));
      cacheWritable = true;
    } catch {
      // An unreadable old value is never replaced by a default outbox.
      cacheWritable = false;
      return { status: "cache-error" };
    }

    pending = restored.pending;
    current = restored.current;
    sound = restored.sound;
    cacheDirty = false;
    recompute();

    const day = dateKey(now());
    state.day = day;
    try {
      applyResponse(await adapter.getState(day), day);
    } catch (error) {
      recompute();
      return {
        status: error instanceof CloudError && error.kind === "permission"
          ? "permission-required"
          : "offline",
      };
    }

    if (!(await flushInternal())) {
      recompute();
      return {
        status: lastFlushError === "cache"
          ? "cache-error"
          : lastFlushError === "permission"
            ? "permission-required"
            : "offline",
      };
    }
    ready = true;
    accepting = true;
    recompute();
    return { status: "ready" };
  }

  function initialize(): Promise<{ status: InitializeStatus }> {
    if (ready) return Promise.resolve({ status: "ready" });
    if (initialization !== null) return initialization;
    initialization = enqueue(initializeAttempt).finally(() => {
      initialization = null;
    });
    return initialization;
  }

  function recordHit(hitTime = now()): {
    accepted: boolean;
    state: CloudState;
    completedWish?: Wish;
  } {
    if (!ready || !accepting || suspended || disposing || disposed) {
      return { accepted: false, state: getState() };
    }

    const previousDay = state.day;
    const nextDay = dateKey(hitTime);
    if (!isDay(nextDay)) return { accepted: false, state: getState() };
    if (nextDay !== previousDay) {
      state.day = nextDay;
      justReachedTarget = false;
      recompute();
    }

    const previousWish = state.activeWish
      ? cloneWish(state.activeWish)
      : null;
    let nextPending = pending;
    let nextCurrent = current;
    const usedIds = new Set(pending.map((batch) => batch.batchId));
    if (current !== null) usedIds.add(current.batchId);

    const needsNewBatch =
      nextCurrent === null ||
      nextCurrent.day !== nextDay ||
      nextCurrent.delta >= MAX_BATCH_DELTA;
    if (needsNewBatch) {
      if (nextCurrent !== null) {
        nextPending = [...nextPending, nextCurrent];
        nextCurrent = null;
      }
      if (nextPending.length >= MAX_PENDING_BATCHES) {
        return { accepted: false, state: getState() };
      }
      let batchId = newBatchId();
      while (usedIds.has(batchId)) batchId = newBatchId();
      nextCurrent = {
        batchId,
        delta: 0,
        day: nextDay,
        dayDelta: 0,
        wishId: state.activeWish?.id ?? null,
      };
    }

    if (nextCurrent === null) {
      return { accepted: false, state: getState() };
    }
    nextCurrent = {
      ...nextCurrent,
      delta: nextCurrent.delta + 1,
      dayDelta: nextCurrent.dayDelta + 1,
    };
    if (
      nextCurrent.delta > MAX_BATCH_DELTA ||
      nextCurrent.dayDelta > nextCurrent.delta ||
      !payloadFits({
        schemaVersion: CLOUD_SCHEMA_VERSION,
        pending: nextPending,
        current: nextCurrent,
        sound,
      })
    ) {
      return { accepted: false, state: getState() };
    }

    const acceptedCurrent = nextCurrent;
    pending = nextPending;
    current = acceptedCurrent;
    justReachedTarget = false;
    recompute();
    let completedWish: Wish | undefined;
    if (
      previousWish !== null &&
      state.activeWish?.id === previousWish.id &&
      previousWish.progress < previousWish.target &&
      state.activeWish.progress >= previousWish.target &&
      acceptedCurrent.wishId === previousWish.id
    ) {
      justReachedTarget = true;
      state.justReachedTarget = true;
      completedWish = cloneWish(state.activeWish);
    }
    scheduleFlush();
    return { accepted: true, state: getState(), ...(completedWish ? { completedWish } : {}) };
  }

  function flush(): Promise<boolean> {
    if (!ready || disposing || disposed) return Promise.resolve(false);
    clearFlushTimer();
    return enqueue(() => flushInternal().then((success) => {
      if (!success) recompute();
      return success;
    }));
  }

  function refresh(): Promise<boolean> {
    if (!ready || disposing || disposed) return Promise.resolve(false);
    clearFlushTimer();
    return enqueue(async () => {
      rollDay();
      if ((pending.length > 0 || current !== null || cacheDirty) &&
        !(await flushInternal())) {
        return false;
      }
      const responseDay = state.day;
      try {
        applyResponse(await adapter.getState(responseDay), responseDay);
        return true;
      } catch {
        // A failed read never replaces known server values with zeroes.
        recompute();
        return false;
      }
    });
  }

  function setSound(enabled: boolean): void {
    sound = enabled;
    cacheDirty = cacheWritable;
    recompute();
    if (ready && accepting) scheduleFlush();
  }

  async function createWish(
    contentValue: string,
    targetValue: WishTarget,
  ): Promise<CreateWishResult> {
    const input = normalizeWishInput(contentValue, targetValue);
    if (input === null) {
      return { ok: false, status: "invalid-input", state: getState() };
    }
    if (!ready || disposing || disposed) {
      return { ok: false, status: "not-ready", state: getState() };
    }

    suspended = true;
    try {
      return await enqueue(async (): Promise<CreateWishResult> => {
        rollDay();
        if (!(await flushInternal())) {
          return { ok: false, status: "sync-failed", state: getState() };
        }
        if (server.activeWish !== null) {
          return {
            ok: false,
            status: "active-wish-exists",
            state: getState(),
          };
        }
        const responseDay = state.day;
        try {
          const response = parseServerState(
            await adapter.createWish(input.content, input.target, responseDay),
          );
          const wish = response.activeWish;
          if (
            wish === null ||
            wish.content !== input.content ||
            wish.target !== input.target
          ) {
            throw new CloudError("invalid-response", "Wish was not activated");
          }
          applyResponse(response, responseDay);
          if (state.activeWish?.id !== wish.id) {
            throw new CloudError("invalid-response", "Stale wish response");
          }
          if (cacheDirty && !(await persist())) {
            return { ok: false, status: "sync-failed", state: getState() };
          }
          return {
            ok: true,
            status: "created",
            state: getState(),
            wish: cloneWish(state.activeWish),
          };
        } catch (error) {
          recompute();
          return {
            ok: false,
            status: error instanceof CloudError &&
                error.kind === "active-wish-exists"
              ? "active-wish-exists"
              : "create-failed",
            state: getState(),
          };
        }
      });
    } finally {
      suspended = false;
      if (ready && accepting && !disposing && !disposed) {
        accepting = true;
      }
    }
  }

  async function dispose(): Promise<void> {
    if (disposed || disposing) return;
    disposing = true;
    accepting = false;
    clearFlushTimer();
    await enqueue(async () => {
      try {
        if (ready && userId !== null && cacheWritable) await flushInternal();
      } finally {
        ready = false;
        disposed = true;
        recompute();
      }
    });
  }

  return {
    initialize,
    getState,
    recordHit,
    flush,
    refresh,
    setSound,
    createWish,
    dispose,
  };
}
