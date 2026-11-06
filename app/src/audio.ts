/**
 * Knock recording: Mokugyo.wav by jonopodmore, CC0 1.0.
 * Freesound: https://freesound.org/people/jonopodmore/sounds/607215/
 * See THIRD_PARTY_NOTICES.md and the bundled media/NOTICE.txt.
 */
import type { MiniAppError, MiniAppSDK } from "@discourse-mini-app/sdk";

const AudioContextCtor: typeof AudioContext | undefined =
  globalThis.AudioContext ??
  (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;

export function createAudio(
  sdk: MiniAppSDK | null,
  callbacks: {
    enabled: () => boolean;
    onUnavailable: () => void;
  },
) {
  let pending = 0;
  let lastPlay = 0;
  let suspendedUntil = 0;
  let notified = false;
  let disposed = false;

  let rawBytes: ArrayBuffer | null = null;
  let blobUrl: string | null = null;
  let loadingBytes: Promise<void> | null = null;

  let audioContext: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let decodedBuffer: AudioBuffer | null = null;
  let decodingPromise: Promise<AudioBuffer | null> | null = null;

  const pool: HTMLAudioElement[] = [];
  let poolIndex = 0;
  const handles = new Set<string>();

  function unavailable(error?: unknown) {
    const code = (error as MiniAppError | null)?.code;
    if (code === "RATE_LIMIT" || code === "MESSAGE_LIMIT") {
      suspendedUntil = Date.now() + 10000;
      return;
    }
    if (code === "APP_UNLOADED") return;
    console.warn("[muyu] Audio unavailable", error);
    if (!notified) {
      notified = true;
      callbacks.onUnavailable();
    }
  }

  function ensureContext(): AudioContext | null {
    if (!AudioContextCtor || disposed) return null;
    if (!audioContext) {
      try {
        audioContext = new AudioContextCtor();
        gainNode = audioContext.createGain();
        gainNode.gain.value = 0.96;
        gainNode.connect(audioContext.destination);
      } catch {
        audioContext = null;
        gainNode = null;
      }
    }
    return audioContext;
  }

  async function decodeBuffer(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    if (decodedBuffer) return decodedBuffer;
    if (decodingPromise) return decodingPromise;
    const ctx = ensureContext();
    if (!ctx) return null;
    decodingPromise = ctx
      .decodeAudioData(bytes.slice(0))
      .then((buffer) => {
        decodedBuffer = buffer;
        return buffer;
      })
      .catch(() => null)
      .finally(() => {
        decodingPromise = null;
      });
    return decodingPromise;
  }

  function initPool(url: string) {
    if (pool.length > 0 || typeof Audio === "undefined") return;
    for (let index = 0; index < 4; index += 1) {
      try {
        const player = new Audio(url);
        player.preload = "auto";
        player.volume = 0.92;
        player.load();
        pool.push(player);
      } catch {
        break;
      }
    }
  }

  function warmup(): Promise<void> {
    if (loadingBytes) return loadingBytes;
    loadingBytes = (async () => {
      try {
        if (!sdk && import.meta.env.DEV) {
          const response = await fetch("media/knock.wav");
          if (!response.ok) return;
          rawBytes = await response.arrayBuffer();
        } else if (sdk) {
          await sdk.ready;
          let bytes: Uint8Array;
          try {
            bytes = await sdk.assets.readBytes("data/knock.wav");
          } catch {
            bytes = await sdk.assets.readBytes("media/knock.wav");
          }
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          rawBytes = copy.buffer;
        }
        if (disposed || !rawBytes) return;
        blobUrl = URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
        initPool(blobUrl);
        await decodeBuffer(rawBytes);
      } catch (error) {
        console.warn("[muyu] Failed to preload knock audio bytes", error);
      }
    })();
    return loadingBytes;
  }

  function triggerBuffer(ctx: AudioContext, buffer: AudioBuffer): boolean {
    if (!gainNode) return false;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);
      source.start(0);
      return true;
    } catch {
      return false;
    }
  }

  async function playWebAudio(): Promise<boolean> {
    const ctx = ensureContext();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Continue and attempt decode/start if allowed by user gesture.
      }
    }
    if (!decodedBuffer) {
      if (!rawBytes) await warmup();
      if (rawBytes && !decodedBuffer) await decodeBuffer(rawBytes);
    }
    if (!decodedBuffer || disposed) return false;
    return triggerBuffer(ctx, decodedBuffer);
  }

  async function playBlobPool(): Promise<boolean> {
    if (pool.length === 0) {
      if (!blobUrl) await warmup();
      if (blobUrl) initPool(blobUrl);
    }
    if (pool.length === 0 || disposed) return false;
    const player = pool[poolIndex % pool.length]!;
    poolIndex = (poolIndex + 1) % pool.length;
    try {
      player.currentTime = 0;
      await player.play();
      return true;
    } catch {
      return false;
    }
  }

  async function play() {
    if (disposed || !callbacks.enabled()) return;
    const now = Date.now();
    if (now < suspendedUntil || now - lastPlay < 35) return;
    lastPlay = now;

    if (sdk && !sdk.permissions.has("audio.play")) {
      unavailable();
      return;
    }

    // Fast path: play directly from decoded Web Audio buffer if already warm.
    if (audioContext && audioContext.state === "running" && decodedBuffer) {
      if (triggerBuffer(audioContext, decodedBuffer)) return;
    }

    if (await playWebAudio()) return;
    if (await playBlobPool()) return;

    if (!sdk || pending >= 2) return;
    pending += 1;
    try {
      const { handle } = await sdk.audio.play("knock", { volume: 0.92 });
      if (disposed) {
        void sdk.audio.stop(handle).catch(() => undefined);
        return;
      }
      handles.add(handle);
    } catch (error) {
      unavailable(error);
    } finally {
      pending -= 1;
    }
  }

  return {
    warmup,
    play,
    dispose() {
      disposed = true;
      for (const handle of handles) {
        if (sdk) void sdk.audio.stop(handle).catch(() => undefined);
      }
      handles.clear();
      for (const player of pool) {
        player.pause();
        player.src = "";
      }
      pool.length = 0;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
        gainNode = null;
      }
    },
  };
}
