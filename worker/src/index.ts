import { authenticateRequest, PlatformAuthError } from "./auth";
import { ActiveWishConflictError, createWish, readState, syncMerit } from "./merit";
import type { Env, UserScope } from "./types";
import {
  readJsonBody,
  RequestValidationError,
  validateDay,
  validateSyncInput,
  validateWishInput,
} from "./validation";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function identityScope(identity: { iss: string; sub: string }): UserScope {
  return { iss: identity.iss, sub: identity.sub };
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store",
      },
    });
  }

  const { pathname, searchParams } = new URL(request.url);
  if (pathname === "/health") {
    if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    return json({ ok: true });
  }

  if (pathname === "/v1/state") {
    if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const identity = await authenticateRequest(request, env);
    const keys = [...searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== "day") throw new RequestValidationError();
    const day = validateDay(searchParams.get("day"));
    return json(await readState(env.DB, identityScope(identity), day));
  }

  if (pathname === "/v1/merit/sync") {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const identity = await authenticateRequest(request, env);
    const input = validateSyncInput(await readJsonBody(request));
    return json(await syncMerit(env.DB, identityScope(identity), input));
  }

  if (pathname === "/v1/wishes") {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const identity = await authenticateRequest(request, env);
    const input = validateWishInput(await readJsonBody(request));
    const days = [...searchParams.keys()];
    if (days.length > 1 || (days.length === 1 && days[0] !== "day")) {
      throw new RequestValidationError();
    }
    const day = days.length === 1
      ? validateDay(searchParams.get("day"))
      : new Date().toISOString().slice(0, 10);
    return json(await createWish(env.DB, identityScope(identity), input, day), 201);
  }

  throw new HttpError(404, "NOT_FOUND");
}

function errorResponse(error: unknown): Response {
  if (error instanceof PlatformAuthError) {
    return json(errorBody(error.code, "Invalid platform request"), 401);
  }
  if (error instanceof RequestValidationError) {
    return json(errorBody(error.code, "Invalid request"), 400);
  }
  if (error instanceof ActiveWishConflictError) {
    return json(errorBody(error.code, "An active wish already exists"), 409);
  }
  if (error instanceof HttpError) {
    return json(errorBody(error.code, error.code === "NOT_FOUND" ? "Not found" : "Method not allowed"), error.status);
  }
  return json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
}

function configuredCorsOrigin(value: string): string {
  if (typeof value !== "string" || value === "*" || value.length > 2048) {
    throw new Error("Invalid CORS_ORIGIN");
  }
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value) {
    throw new Error("Invalid CORS_ORIGIN");
  }
  return value;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  let response: Response;
  try {
    response = await route(request, env);
  } catch (error) {
    response = errorResponse(error);
  }

  try {
    const origin = configuredCorsOrigin(env.CORS_ORIGIN);
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.append("Vary", "Origin");
    return response;
  } catch {
    return json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
  }
}

export default {
  fetch: handleRequest,
};
