/**
 * Knock recording: Mokugyo.wav by jonopodmore, CC0 1.0.
 * Freesound: https://freesound.org/people/jonopodmore/sounds/607215/
 * See THIRD_PARTY_NOTICES.md and the bundled media/NOTICE.txt.
 */
import type { MiniAppError, MiniAppSDK } from "@discourse-mini-app/sdk";

export function createAudio(
  sdk: MiniAppSDK | null,
  callbacks: {
    enabled: () => boolean;
    onUnavailable: () => void;
  }
) {
  let pending = 0;
  let lastPlay = 0;
  let suspendedUntil = 0;
  let notified = false;
  let disposed = false;
  const handles = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const previewPlayers = new Set<HTMLAudioElement>();

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

  function stopHandle(handle: string) {
    handles.delete(handle);
    if (!sdk) return;
    void sdk.audio.stop(handle).catch(() => undefined);
  }

  let previewAudio: HTMLAudioElement | null = null;

  function warmup() {
    if (sdk || !import.meta.env.DEV || previewAudio) return;
    try {
      previewAudio = new Audio("media/knock.wav");
      previewAudio.preload = "auto";
      previewAudio.load();
    } catch {
      previewAudio = null;
    }
  }

  function playPreview() {
    if (previewPlayers.size >= 4) return;
    const player = previewAudio
      ? (previewAudio.cloneNode() as HTMLAudioElement)
      : new Audio("media/knock.wav");
    previewPlayers.add(player);
    player.volume = 0.92;
    player.addEventListener("ended", () => previewPlayers.delete(player), {
      once: true,
    });
    player.addEventListener("error", () => previewPlayers.delete(player), {
      once: true,
    });
    void player.play().catch(() => previewPlayers.delete(player));
  }

  async function play() {
    if (disposed || !callbacks.enabled()) return;
    const now = Date.now();
    if (now < suspendedUntil || now - lastPlay < 45 || pending >= 3) return;
    lastPlay = now;
    if (!sdk && import.meta.env.DEV) {
      playPreview();
      return;
    }
    if (!sdk || !sdk.permissions.has("audio.play")) {
      unavailable();
      return;
    }
    pending += 1;
    try {
      const { handle } = await sdk.audio.play("knock", { volume: 0.92 });
      if (disposed) {
        void sdk.audio.stop(handle).catch(() => undefined);
        return;
      }
      handles.add(handle);
      const timer = setTimeout(() => {
        timers.delete(timer);
        stopHandle(handle);
      }, 450);
      timers.add(timer);
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
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const handle of handles) stopHandle(handle);
      for (const player of previewPlayers) {
        player.pause();
        player.src = "";
      }
      previewPlayers.clear();
    },
  };
}
