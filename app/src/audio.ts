/**
 * Knock recording: Mokugyo.wav by jonopodmore, CC0 1.0.
 * Freesound: https://freesound.org/people/jonopodmore/sounds/607215/
 * See THIRD_PARTY_NOTICES.md and the bundled media/NOTICE.txt.
 */
import type { MiniAppError, MiniAppSDK } from "@discourse-mini-app/sdk";
import { KNOCK_WAV_BASE64 } from "./knock-wav.ts";

const AudioContextCtor: typeof AudioContext | undefined =
  globalThis.AudioContext ??
  (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;

interface PcmData {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Decodes the embedded base64 16-bit mono PCM WAV directly inside the iframe's
 * own V8 realm so we never hit cross-realm ArrayBuffer issues or blob: requests.
 */
function decodeEmbeddedWavPcm(): PcmData | null {
  try {
    const binary = atob(KNOCK_WAV_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.byteLength < 44) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sampleRate = 44100;
    let offset = 12;
    let dataOffset = 44;
    let dataLength = bytes.byteLength - 44;

    while (offset + 8 <= bytes.byteLength) {
      const id =
        String.fromCharCode(bytes[offset]!) +
        String.fromCharCode(bytes[offset + 1]!) +
        String.fromCharCode(bytes[offset + 2]!) +
        String.fromCharCode(bytes[offset + 3]!);
      const size = view.getUint32(offset + 4, true);
      if (id === "fmt " && offset + 16 <= bytes.byteLength) {
        sampleRate = view.getUint32(offset + 12, true) || 44100;
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataLength = Math.min(size, bytes.byteLength - dataOffset);
        break;
      }
      offset += 8 + size + (size & 1);
    }

    const sampleCount = Math.floor(dataLength / 2);
    if (sampleCount <= 0) return null;
    const samples = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768;
    }
    return { samples, sampleRate };
  } catch (error) {
    console.warn("[muyu] Failed to decode embedded knock WAV", error);
    return null;
  }
}

export function createAudio(
  sdk: MiniAppSDK | null,
  callbacks: {
    enabled: () => boolean;
    onUnavailable: () => void;
  },
) {
  let lastPlay = 0;
  let notified = false;
  let disposed = false;

  let pcmData: PcmData | null = null;
  let audioContext: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let audioBuffer: AudioBuffer | null = null;
  let queuedPlay = false;

  function unavailable(error?: unknown) {
    const code = (error as MiniAppError | null)?.code;
    if (code === "APP_UNLOADED") return;
    console.warn("[muyu] Audio unavailable", error);
    if (!notified) {
      notified = true;
      callbacks.onUnavailable();
    }
  }

  function ensureContext(): AudioContext | null {
    if (!AudioContextCtor || disposed) return null;
    if (!pcmData) {
      pcmData = decodeEmbeddedWavPcm();
    }
    if (!audioContext) {
      try {
        audioContext = new AudioContextCtor();
        gainNode = audioContext.createGain();
        gainNode.gain.value = 0.98;
        gainNode.connect(audioContext.destination);
      } catch (error) {
        unavailable(error);
        audioContext = null;
        gainNode = null;
      }
    }
    if (audioContext && pcmData && !audioBuffer) {
      try {
        const buffer = audioContext.createBuffer(
          1,
          pcmData.samples.length,
          pcmData.sampleRate,
        );
        buffer.getChannelData(0).set(pcmData.samples);
        audioBuffer = buffer;
      } catch (error) {
        unavailable(error);
      }
    }
    return audioContext;
  }

  function triggerSource(ctx: AudioContext): boolean {
    if (!gainNode || !audioBuffer) return false;
    try {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      source.start(0);
      return true;
    } catch (error) {
      unavailable(error);
      return false;
    }
  }

  async function warmup(): Promise<void> {
    if (!pcmData) {
      pcmData = decodeEmbeddedWavPcm();
    }
  }

  function unlock() {
    if (disposed || !callbacks.enabled()) return;
    if (sdk && !sdk.permissions.has("audio.webAudio")) return;
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx
        .resume()
        .then(() => {
          if (queuedPlay && !disposed && callbacks.enabled()) {
            queuedPlay = false;
            if (ctx.state === "running") {
              triggerSource(ctx);
            } else {
              unavailable(new Error("AudioContext did not resume"));
            }
          }
        })
        .catch((error) => {
          queuedPlay = false;
          unavailable(error);
        });
    } else if (queuedPlay) {
      queuedPlay = false;
      triggerSource(ctx);
    }
  }

  async function play() {
    if (disposed || !callbacks.enabled()) return;
    const now = Date.now();
    if (now - lastPlay < 35) return;
    lastPlay = now;

    if (sdk && !sdk.permissions.has("audio.webAudio")) {
      unavailable();
      return;
    }

    const ctx = ensureContext();
    if (!ctx || !audioBuffer) {
      unavailable();
      return;
    }

    if (ctx.state === "suspended") {
      queuedPlay = true;
      try {
        await ctx.resume();
      } catch (error) {
        queuedPlay = false;
        unavailable(error);
        return;
      }
      if ((ctx.state as AudioContextState) !== "running") {
        queuedPlay = false;
        unavailable(new Error("AudioContext did not resume"));
        return;
      }
      queuedPlay = false;
    }

    triggerSource(ctx);
  }

  return {
    warmup,
    unlock,
    play,
    dispose() {
      disposed = true;
      queuedPlay = false;
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
        gainNode = null;
        audioBuffer = null;
      }
    },
  };
}
