import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { MiniAppSDK, Permission } from "@discourse-mini-app/sdk";

const sources: { start: (time: number) => void; connect: (target: unknown) => void }[] = [];
const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  static resumeError: Error | null = null;
  readonly destination = {};
  state: AudioContextState = "suspended";
  resumeCalls = 0;
  closeCalls = 0;
  bufferCalls = 0;
  samplesWritten = 0;
  sampleRate = 0;
  readonly gain = { value: 0 };

  constructor() {
    contexts.push(this);
  }

  createGain() {
    return { gain: this.gain, connect: () => undefined };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    this.bufferCalls += 1;
    this.sampleRate = sampleRate;
    return {
      getChannelData: () => ({
        set: (samples: Float32Array) => {
          this.samplesWritten = samples.length;
        },
      }),
    };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      connect: () => undefined,
      start: () => {
        sources.push(source);
      },
    };
    return source;
  }

  async resume() {
    this.resumeCalls += 1;
    if (FakeAudioContext.resumeError) throw FakeAudioContext.resumeError;
    this.state = "running";
  }

  async close() {
    this.closeCalls += 1;
    this.state = "closed";
  }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
Object.defineProperty(globalThis, "AudioContext", {
  configurable: true,
  writable: true,
  value: FakeAudioContext,
});
const { createAudio } = await import("../src/audio.ts");

afterAll(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, "AudioContext", originalDescriptor);
  } else {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  }
});

beforeEach(() => {
  contexts.length = 0;
  sources.length = 0;
  FakeAudioContext.resumeError = null;
});

function mockedSdk(permissions = new Set<Permission>(["audio.webAudio"])) {
  let playCalls = 0;
  const sdk = {
    permissions: { has: (permission: Permission) => permissions.has(permission) },
    audio: {
      play: async () => {
        playCalls += 1;
        throw new Error("SDK audio RPC must not be used");
      },
    },
  } as unknown as MiniAppSDK;
  return { sdk, playCalls: () => playCalls };
}

describe("local Web Audio playback", () => {
  test("reuses one context and one decoded buffer without SDK audio RPC", async () => {
    const mock = mockedSdk();
    const audio = createAudio(mock.sdk, { enabled: () => true, onUnavailable: () => { throw new Error("unexpected unavailable"); } });
    await audio.warmup();
    await audio.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.resumeCalls).toBe(1);
    expect(contexts[0]!.bufferCalls).toBe(1);
    expect(contexts[0]!.samplesWritten).toBeGreaterThan(1000);
    expect(contexts[0]!.sampleRate).toBe(44100);
    expect(sources).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 36));
    await audio.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.bufferCalls).toBe(1);
    expect(sources).toHaveLength(2);
    expect(mock.playCalls()).toBe(0);
    audio.dispose();
    expect(contexts[0]!.closeCalls).toBe(1);
  });

  test("does not initialize native audio when webAudio permission is missing", async () => {
    const mock = mockedSdk(new Set());
    let unavailableCalls = 0;
    const audio = createAudio(mock.sdk, {
      enabled: () => true,
      onUnavailable: () => { unavailableCalls += 1; },
    });
    await audio.play();
    expect(contexts).toHaveLength(0);
    expect(sources).toHaveLength(0);
    expect(unavailableCalls).toBe(1);
    expect(mock.playCalls()).toBe(0);
    audio.dispose();
  });

  test("reports a rejected resume and does not start a source", async () => {
    FakeAudioContext.resumeError = new Error("Permission denied");
    const mock = mockedSdk();
    let unavailableCalls = 0;
    const audio = createAudio(mock.sdk, {
      enabled: () => true,
      onUnavailable: () => { unavailableCalls += 1; },
    });
    await audio.play();
    expect(sources).toHaveLength(0);
    expect(unavailableCalls).toBe(1);
    expect(mock.playCalls()).toBe(0);
    audio.dispose();
  });
});
