import { describe, expect, it } from "bun:test";
import {
  addMerit,
  clearMerit,
  dateKey,
  defaultState,
  restoreState,
  rollDay,
  setSound,
} from "../src/merit.ts";

const morning = new Date(2026, 10, 6, 8, 0, 0);
const nextDay = new Date(2026, 10, 7, 0, 0, 1);

describe("merit state", () => {
  it("uses a local calendar date", () => {
    expect(dateKey(morning)).toBe("2026-11-06");
    expect(defaultState(morning)).toEqual({
      version: 1,
      total: 0,
      day: "2026-11-06",
      today: 0,
      sound: true,
    });
  });

  it("adds total and today's merit without mutating the old state", () => {
    const initial = defaultState(morning);
    const next = addMerit(addMerit(initial, morning), morning);
    expect(initial.total).toBe(0);
    expect(next.total).toBe(2);
    expect(next.today).toBe(2);
  });

  it("rolls today's counter across midnight before adding", () => {
    const previous = {
      ...defaultState(morning),
      total: 108,
      today: 108,
      sound: false,
    };
    const next = addMerit(previous, nextDay);
    expect(next).toEqual({
      version: 1,
      total: 109,
      day: "2026-11-07",
      today: 1,
      sound: false,
    });
  });

  it("restores a same-day record", () => {
    const saved = JSON.stringify({
      version: 1,
      total: 88,
      day: "2026-11-06",
      today: 12,
      sound: false,
    });
    expect(restoreState(saved, morning)).toEqual({
      state: {
        version: 1,
        total: 88,
        day: "2026-11-06",
        today: 12,
        sound: false,
      },
      corrupted: false,
    });
  });

  it("keeps total but resets today for an old record", () => {
    const saved = JSON.stringify({
      ...defaultState(morning),
      total: 52,
      today: 52,
    });
    const { state, corrupted } = restoreState(saved, nextDay);
    expect(corrupted).toBe(false);
    expect(state.total).toBe(52);
    expect(state.today).toBe(0);
    expect(state.day).toBe("2026-11-07");
  });

  it("rejects corrupt or unsafe data", () => {
    for (const saved of [
      "not json",
      "null",
      JSON.stringify({ version: 1, total: -1 }),
      JSON.stringify({
        version: 1,
        total: 1.5,
        day: "2026-11-06",
        today: 1,
        sound: true,
      }),
    ]) {
      const result = restoreState(saved, morning);
      expect(result.corrupted).toBe(true);
      expect(result.state).toEqual(defaultState(morning));
    }
  });

  it("does not overflow unsafe counters", () => {
    const state = {
      ...defaultState(morning),
      total: Number.MAX_SAFE_INTEGER,
      today: Number.MAX_SAFE_INTEGER,
    };
    expect(addMerit(state, morning)).toEqual(state);
  });

  it("clears merit while retaining preferences", () => {
    const state = setSound(
      { ...defaultState(morning), total: 9, today: 9 },
      false
    );
    expect(clearMerit(state, nextDay)).toEqual({
      version: 1,
      total: 0,
      day: "2026-11-07",
      today: 0,
      sound: false,
    });
  });

  it("only rolls the date when needed", () => {
    const state = defaultState(morning);
    expect(rollDay(state, morning)).toBe(state);
    expect(rollDay(state, nextDay).today).toBe(0);
  });
});
