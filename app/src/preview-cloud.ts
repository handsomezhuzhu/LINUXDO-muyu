import {
  CloudError,
  cloneServerState,
  isDay,
  normalizeWishInput,
  parsePendingPayload,
  parseServerState,
  parseSyncBatch,
  serializePendingPayload,
} from "./cloud.ts";
import type {
  CloudAdapter,
  ServerState,
  SyncBatch,
  Wish,
  WishTarget,
} from "./cloud.ts";
import { cloudStorageKey } from "./discourse-cloud.ts";

export const PREVIEW_SERVER_KEY = "muyu:preview:server:v1:1";
const PREVIEW_USER_ID = 1;
const PREVIEW_HISTORY_LIMIT = 50;

interface PreviewServer {
  schemaVersion: 1;
  revision: number;
  total: number;
  days: Record<string, number>;
  activeWish: Wish | null;
  wishes: Wish[];
  batches: Record<string, SyncBatch>;
}

export interface PreviewCloudOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => Date;
}

function freshServer(): PreviewServer {
  return {
    schemaVersion: 1,
    revision: 0,
    total: 0,
    days: {},
    activeWish: null,
    wishes: [],
    batches: {},
  };
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseServer(value: unknown): PreviewServer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid preview server");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.days !== "object" ||
    record.days === null ||
    Array.isArray(record.days) ||
    typeof record.batches !== "object" ||
    record.batches === null ||
    Array.isArray(record.batches)
  ) {
    throw new Error("invalid preview server");
  }
  const state = parseServerState({
    revision: record.revision,
    total: record.total,
    today: 0,
    activeWish: record.activeWish,
    wishes: record.wishes,
  });
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(record.days)) {
    if (!isDay(day) || !isCount(count)) throw new Error("invalid preview day");
    days[day] = count;
  }
  const batches: Record<string, SyncBatch> = {};
  for (const [batchId, value] of Object.entries(record.batches)) {
    const batch = parseSyncBatch(value);
    if (batch.batchId !== batchId) throw new Error("invalid preview batch");
    batches[batchId] = batch;
  }
  return {
    schemaVersion: 1,
    revision: state.revision,
    total: state.total,
    days,
    activeWish: state.activeWish,
    wishes: state.wishes,
    batches,
  };
}

function add(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new CloudError("offline", "Preview counter overflow");
  }
  return result;
}

/**
 * Development-only in-memory HTTP semantics backed by browser localStorage.
 * The production adapter is createDiscourseCloudAdapter; this is not a fake SDK.
 */
export function createPreviewCloudAdapter(
  options: PreviewCloudOptions = {},
): CloudAdapter {
  const now = options.now ?? (() => new Date());

  function storage(): Pick<Storage, "getItem" | "setItem"> {
    if (options.storage) return options.storage;
    if (typeof window === "undefined") {
      throw new CloudError("cache", "Browser storage is unavailable");
    }
    return window.localStorage;
  }

  function loadServer(): PreviewServer {
    try {
      const raw = storage().getItem(PREVIEW_SERVER_KEY);
      return raw === null ? freshServer() : parseServer(JSON.parse(raw));
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError("offline", "Preview server data is invalid");
    }
  }

  function saveServer(server: PreviewServer): void {
    try {
      storage().setItem(PREVIEW_SERVER_KEY, JSON.stringify(server));
    } catch {
      throw new CloudError("offline", "Preview server write failed");
    }
  }

  function view(server: PreviewServer, day: string): ServerState {
    const state: ServerState = {
      revision: server.revision,
      total: server.total,
      today: server.days[day] ?? 0,
      activeWish: server.activeWish,
      wishes: server.wishes,
    };
    return cloneServerState(state);
  }

  return {
    async getLoginUser() {
      return { id: PREVIEW_USER_ID };
    },

    async loadPending(userId) {
      if (userId !== PREVIEW_USER_ID) throw new CloudError("cache");
      try {
        return storage().getItem(cloudStorageKey(userId));
      } catch {
        throw new CloudError("cache", "Preview outbox read failed");
      }
    },

    async savePending(userId, payload) {
      if (userId !== PREVIEW_USER_ID) return false;
      try {
        const checked = serializePendingPayload(parsePendingPayload(payload));
        storage().setItem(cloudStorageKey(userId), checked);
        return true;
      } catch {
        return false;
      }
    },

    async getState(day) {
      if (!isDay(day)) throw new CloudError("offline", "Invalid day");
      return view(loadServer(), day);
    },

    async sync(batchValue, day) {
      if (!isDay(day)) throw new CloudError("offline", "Invalid day");
      const batch = parseSyncBatch(batchValue);
      const server = loadServer();
      // Replays return the current view without another increment or revision.
      if (server.batches[batch.batchId]) return view(server, day);

      server.total = add(server.total, batch.delta);
      server.days[batch.day] = add(server.days[batch.day] ?? 0, batch.dayDelta);
      const active = server.activeWish;
      if (active && batch.wishId === active.id) {
        active.progress = Math.min(
          active.target,
          add(active.progress, batch.delta),
        );
        if (active.progress === active.target) {
          const completed = {
            ...active,
            completedAt: now().toISOString(),
          };
          server.wishes = [completed, ...server.wishes]
            .slice(0, PREVIEW_HISTORY_LIMIT);
          server.activeWish = null;
        }
      }
      server.batches[batch.batchId] = { ...batch };
      server.revision += 1;
      saveServer(server);
      return view(server, day);
    },

    async createWish(content, target: WishTarget, day) {
      if (!isDay(day)) throw new CloudError("offline", "Invalid day");
      const input = normalizeWishInput(content, target);
      if (input === null) throw new CloudError("offline", "Invalid wish input");
      const server = loadServer();
      if (server.activeWish !== null) {
        throw new CloudError("active-wish-exists");
      }
      server.activeWish = {
        id: globalThis.crypto.randomUUID(),
        content: input.content,
        target: input.target,
        progress: 0,
        createdAt: now().toISOString(),
      };
      server.revision += 1;
      saveServer(server);
      return view(server, day);
    },
  };
}
