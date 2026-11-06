import type {
  HttpRequestOptions,
  JsonValue,
  MiniAppSDK,
  Permission,
} from "@discourse-mini-app/sdk";
import {
  CloudError,
  isDay,
  normalizeWishInput,
  parsePendingPayload,
  parseServerState,
  parseSyncBatch,
  serializePendingPayload,
  utf8Bytes,
} from "./cloud.ts";
import type {
  CloudAdapter,
  ServerState,
  SyncBatch,
  WishTarget,
} from "./cloud.ts";

/** Manifest endpoint names shared with the production build configuration. */
export const CLOUD_ENDPOINTS = {
  getState: "getState",
  syncMerit: "syncMerit",
  createWish: "createWish",
} as const;

export function cloudStorageKey(userId: number): string {
  return `muyu:cloud:v1:${userId}`;
}

function permissionError(): CloudError {
  return new CloudError("permission", "Required mini-app permission is absent");
}

function asSdkError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "PERMISSION_DENIED" || code === "ACCESS_DENIED") {
    return permissionError();
  }
  return new CloudError("offline", "Mini-app request failed");
}

export function createDiscourseCloudAdapter(sdk: MiniAppSDK): CloudAdapter {
  function requirePermission(permission: Permission): void {
    if (!sdk.permissions.has(permission)) throw permissionError();
  }

  async function request(
    endpoint: string,
    options: HttpRequestOptions,
  ): Promise<ServerState> {
    requirePermission("network.request");
    try {
      if (options.json !== undefined &&
        utf8Bytes(JSON.stringify(options.json)) > 4096) {
        throw new CloudError("invalid-response", "Request body exceeds 4 KiB");
      }
      const response = await sdk.http.request(endpoint, options);
      if (response.status === 401 || response.status === 403) {
        throw new CloudError("service", `Service rejected the request (${response.status})`);
      }
      if (response.status === 409) {
        throw new CloudError("active-wish-exists", "An active wish exists");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new CloudError("offline", "Cloud request failed");
      }
      return parseServerState(response.body);
    } catch (error) {
      throw asSdkError(error);
    }
  }

  function batchJson(batch: SyncBatch): JsonValue {
    return {
      batchId: batch.batchId,
      delta: batch.delta,
      day: batch.day,
      dayDelta: batch.dayDelta,
      wishId: batch.wishId,
    };
  }

  return {
    async getLoginUser() {
      try {
        await sdk.ready;
        // All four are required before any old outbox can be read or changed.
        requirePermission("user.read");
        requirePermission("network.request");
        requirePermission("storage.read");
        requirePermission("storage.write");
        const user = await sdk.user.getCurrent();
        return user === null ? null : { id: user.id };
      } catch (error) {
        throw asSdkError(error);
      }
    },

    async loadPending(userId) {
      requirePermission("storage.read");
      try {
        return await sdk.localStorage.getItem(cloudStorageKey(userId));
      } catch (error) {
        throw asSdkError(error);
      }
    },

    async savePending(userId, payload) {
      try {
        requirePermission("storage.write");
        // Refuse malformed or oversized values even if called outside the controller.
        const parsed = parsePendingPayload(payload);
        const serialized = serializePendingPayload(parsed);
        await sdk.localStorage.setItem(cloudStorageKey(userId), serialized);
        return true;
      } catch {
        return false;
      }
    },

    async getState(day) {
      if (!isDay(day)) throw new CloudError("offline", "Invalid day");
      return request(CLOUD_ENDPOINTS.getState, {
        method: "GET",
        query: { day },
      });
    },

    async sync(batch, day) {
      if (!isDay(day)) throw new CloudError("offline", "Invalid day");
      const checked = parseSyncBatch(batch);
      return request(CLOUD_ENDPOINTS.syncMerit, {
        method: "POST",
        json: batchJson(checked),
      });
    },

    async createWish(content: string, target: WishTarget, day: string) {
      const input = normalizeWishInput(content, target);
      if (input === null || !isDay(day)) {
        throw new CloudError("offline", "Invalid wish input");
      }
      return request(CLOUD_ENDPOINTS.createWish, {
        method: "POST",
        query: { day },
        json: { content: input.content, target: input.target },
      });
    },
  };
}
