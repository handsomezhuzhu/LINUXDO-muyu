export interface AppState {
  version: 1;
  total: number;
  day: string;
  today: number;
  sound: boolean;
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function dateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultState(now = new Date()): AppState {
  return { version: 1, total: 0, day: dateKey(now), today: 0, sound: true };
}

export function restoreState(
  serialized: string | null,
  now = new Date()
): { state: AppState; corrupted: boolean } {
  if (serialized === null) {
    return { state: defaultState(now), corrupted: false };
  }
  try {
    const value = JSON.parse(serialized) as Partial<AppState>;
    if (
      value.version !== 1 ||
      !validCount(value.total) ||
      !validCount(value.today) ||
      typeof value.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      typeof value.sound !== "boolean"
    ) {
      return { state: defaultState(now), corrupted: true };
    }
    const currentDay = dateKey(now);
    return {
      state: {
        version: 1,
        total: value.total,
        day: currentDay,
        today: value.day === currentDay ? value.today : 0,
        sound: value.sound,
      },
      corrupted: false,
    };
  } catch {
    return { state: defaultState(now), corrupted: true };
  }
}

export function rollDay<T extends AppState>(state: T, now = new Date()): T {
  const currentDay = dateKey(now);
  return state.day === currentDay
    ? state
    : { ...state, day: currentDay, today: 0 };
}

export function addMerit<T extends AppState>(state: T, now = new Date()): T {
  const current = rollDay(state, now);
  if (
    current.total >= Number.MAX_SAFE_INTEGER ||
    current.today >= Number.MAX_SAFE_INTEGER
  ) {
    return current;
  }
  return { ...current, total: current.total + 1, today: current.today + 1 };
}

export function setSound<T extends AppState>(state: T, sound: boolean): T {
  return state.sound === sound ? state : { ...state, sound };
}

export function clearMerit<T extends AppState>(state: T, now = new Date()): T {
  return { ...state, total: 0, day: dateKey(now), today: 0 };
}
