const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type SyncInput = {
  batchId: string;
  delta: number;
  day: string;
  dayDelta: number;
  wishId: string | null;
};

export type WishInput = {
  content: string;
  target: 108 | 1008 | 10080;
};

export class RequestValidationError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message = "Invalid request") {
    super(message);
    this.name = "RequestValidationError";
  }
}

function invalid(): never {
  throw new RequestValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) invalid();
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.length > allowed.size || keys.some((key) => !allowed.has(key))) invalid();
  if (required.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}

export function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid();
  return value.toLowerCase();
}

export function validateDay(value: unknown): string {
  if (typeof value !== "string") invalid();
  const match = DAY_PATTERN.exec(value);
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) invalid();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > monthLengths[month - 1]!) invalid();
  return value;
}

export function validateSyncInput(value: unknown): SyncInput {
  const input = requireFields(value, ["batchId", "delta", "day", "dayDelta", "wishId"]);
  if (!Number.isSafeInteger(input.delta) || Number(input.delta) < 1 || Number(input.delta) > 2000) {
    invalid();
  }
  if (input.dayDelta !== input.delta) invalid();
  return {
    batchId: normalizeUuid(input.batchId),
    delta: Number(input.delta),
    day: validateDay(input.day),
    dayDelta: Number(input.dayDelta),
    wishId: input.wishId === null ? null : normalizeUuid(input.wishId),
  };
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateWishInput(value: unknown): WishInput {
  const input = requireFields(value, ["content", "target"]);
  if (typeof input.content !== "string") invalid();
  const content = input.content.trim();
  const length = Array.from(content).length;
  if (length < 1 || length > 80 || !isWellFormedUnicode(content)) invalid();
  if (input.target !== 108 && input.target !== 1008 && input.target !== 10080) invalid();
  return { content, target: input.target };
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalid();
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > 16_384) {
    invalid();
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16_384) invalid();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
}
