import type {
  MiniAppSDK,
  MiniAppTheme,
  Permission,
} from "@discourse-mini-app/sdk";
import type { AppState } from "./merit.ts";

const STORAGE_KEY = "muyu:preferences:v1";
const SAVE_DELAY = 2000;
const RETRY_DELAY = 10000;

export interface StoredStateResult {
  ok: boolean;
  value: string | null;
}

export function createHost(
  sdk: MiniAppSDK | null,
  callbacks: {
    onTheme: (theme: MiniAppTheme) => void;
    onNotice: (text: string) => void;
    onStorageError: () => void;
  }
) {
  let connected = false;
  let disposed = false;
  let canSave = false;
  let unsubscribe: (() => void) | null = null;
  let latest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writes: Promise<boolean> = Promise.resolve(true);
  let storageErrorReported = false;

  const can = (permission: Permission) =>
    connected && Boolean(sdk?.permissions.has(permission));

  function storageError() {
    if (!storageErrorReported) {
      storageErrorReported = true;
      callbacks.onStorageError();
    }
  }

  async function readStoredState(): Promise<StoredStateResult> {
    if (!sdk && import.meta.env.DEV) {
      try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        canSave = true;
        return { ok: true, value };
      } catch {
        storageError();
        return { ok: false, value: null };
      }
    }
    if (!sdk || !can("storage.read")) {
      storageError();
      return { ok: false, value: null };
    }
    try {
      const value = await sdk.localStorage.getItem(STORAGE_KEY);
      canSave = can("storage.write");
      return { ok: true, value };
    } catch (error) {
      console.warn("[muyu] Failed to restore local state", error);
      storageError();
      return { ok: false, value: null };
    }
  }

  async function writeStoredState(serialized: string): Promise<boolean> {
    if (!canSave) return false;
    if (!sdk && import.meta.env.DEV) {
      try {
        window.localStorage.setItem(STORAGE_KEY, serialized);
        storageErrorReported = false;
        return true;
      } catch (error) {
        console.warn("[muyu] Failed to save preview state", error);
        storageError();
        return false;
      }
    }
    if (!sdk) return false;
    try {
      await sdk.localStorage.setItem(STORAGE_KEY, serialized);
      storageErrorReported = false;
      return true;
    } catch (error) {
      console.warn("[muyu] Failed to save local state", error);
      storageError();
      return false;
    }
  }

  function scheduleFlush(delay = SAVE_DELAY) {
    if (!disposed && timer === null && latest !== null && canSave) {
      timer = setTimeout(() => void flush(), delay);
    }
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const serialized = latest;
    if (serialized !== null) {
      writes = writes.then(async () => {
        const success = await writeStoredState(serialized);
        // Keep both newer snapshots and failed writes for a later retry.
        if (success && latest === serialized) latest = null;
        return success;
      });
    }
    const success = await writes;
    scheduleFlush(success ? SAVE_DELAY : RETRY_DELAY);
  }

  return {
    can,
    async connect(): Promise<StoredStateResult> {
      canSave = false;
      if (!sdk) return readStoredState();
      try {
        await sdk.ready;
        connected = true;
        if (can("theme.read")) {
          unsubscribe = sdk.theme.onChange(callbacks.onTheme);
          callbacks.onTheme(await sdk.theme.get());
        }
      } catch (error) {
        console.warn("[muyu] Community connection failed", error);
        callbacks.onNotice("COMMUNITY_ERROR");
      }
      const result = await readStoredState();
      if (result.ok && !canSave) storageError();
      return result;
    },
    save(state: AppState) {
      // Never overwrite an unread record with a new default state.
      if (disposed || !canSave) return;
      latest = JSON.stringify(state);
      scheduleFlush();
    },
    flush,
    async rendered() {
      if (!sdk) return;
      try {
        await sdk.lifecycle.ready();
      } catch (error) {
        console.warn("[muyu] Lifecycle notification failed", error);
      }
    },
    async dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      await flush();
      // RPC is inherently best-effort during unload; no further writes are allowed.
      canSave = false;
      connected = false;
    },
  };
}
