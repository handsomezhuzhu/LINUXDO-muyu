import type { Channel, Env, PlatformIdentity } from "./types";

const JWKS_TTL_MS = 5 * 60 * 1000;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30 * 1000;
const MAX_JWKS_KEYS = 32;
const MAX_JWKS_BYTES = 256 * 1024;

interface AuthConfig {
  PLATFORM_ISSUER: string;
  PLATFORM_JWKS_URL: string;
  PLATFORM_AUDIENCE: string;
  PLATFORM_APP_ID: string;
  APP_VERSION?: string;
  CHANNEL: Channel;
}

interface VerifyOptions extends AuthConfig {
  authorization: string | null;
  method: string;
  url: string | URL;
  now?: number;
}

interface JwksCacheEntry {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
  refreshCooldownUntil: number;
  refreshing: Promise<void> | null;
}

const jwksCaches = new Map<string, JwksCacheEntry>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export class PlatformAuthError extends Error {
  readonly code = "INVALID_PLATFORM_REQUEST";

  constructor() {
    super("Invalid platform request");
    this.name = "PlatformAuthError";
  }
}

function invalid(): never {
  throw new PlatformAuthError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) invalid();
    return bytes;
  } catch {
    invalid();
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 1024));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeJson(part: string): unknown {
  return JSON.parse(utf8Decoder.decode(decodeBase64Url(part))) as unknown;
}

function parseHttpsUrl(value: string | URL): { parsed: URL; query: string } {
  const raw = typeof value === "string" ? value : value instanceof URL ? value.href : invalid();
  if (raw.length > 2048 || /[^\x21-\x7e]|\\|#/.test(raw)) invalid();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid();
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) invalid();
  const rawPath = /^https:\/\/[^/?#]*([^?#]*)/i.exec(raw)?.[1];
  if (rawPath === undefined || (rawPath || "/") !== parsed.pathname) invalid();
  const questionMark = raw.indexOf("?");
  return { parsed, query: questionMark < 0 ? "" : raw.slice(questionMark + 1) };
}

function verifyEndpointUrl(
  htu: string,
  queryKeys: unknown,
  actualUrl: string | URL,
  audience: string,
): string[] {
  if (typeof htu !== "string" || htu.length > 2048) invalid();
  const signed = parseHttpsUrl(htu);
  const actual = parseHttpsUrl(actualUrl);
  if (
    signed.parsed.searchParams.has("mini_app_token") ||
    signed.parsed.origin !== audience ||
    actual.parsed.origin !== signed.parsed.origin ||
    actual.parsed.pathname !== signed.parsed.pathname
  ) {
    invalid();
  }
  if (!Array.isArray(queryKeys) || queryKeys.length > 16) invalid();

  const permitted = new Set<string>();
  for (const key of queryKeys) {
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(key) ||
      key === "mini_app_token" ||
      permitted.has(key) ||
      signed.parsed.searchParams.has(key)
    ) {
      invalid();
    }
    permitted.add(key);
  }

  let dynamicQuery = "";
  if (actual.query !== signed.query) {
    if (signed.query && !actual.query.startsWith(`${signed.query}&`)) invalid();
    dynamicQuery = signed.query ? actual.query.slice(signed.query.length + 1) : actual.query;
    if (!dynamicQuery) invalid();
  }

  const dynamic = new URLSearchParams(dynamicQuery);
  if (dynamic.toString() !== dynamicQuery || dynamic.size > 16) invalid();
  const seen = new Set<string>();
  for (const [key, value] of dynamic) {
    if (!permitted.has(key) || seen.has(key) || textEncoder.encode(value).length > 200) invalid();
    seen.add(key);
  }
  return [...permitted];
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function platformKeyId(publicKey: CryptoKey): Promise<string> {
  if (
    publicKey.type !== "public" ||
    publicKey.algorithm.name !== "ECDSA" ||
    (publicKey.algorithm as KeyAlgorithm & { namedCurve?: string }).namedCurve !== "P-256"
  ) {
    invalid();
  }
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return hex(new Uint8Array(digest));
}

async function importPublicJwk(value: unknown): Promise<{ kid: string; key: CryptoKey } | null> {
  try {
    if (
      !isRecord(value) ||
      value.kty !== "EC" ||
      value.crv !== "P-256" ||
      Object.hasOwn(value, "d") ||
      typeof value.kid !== "string" ||
      (value.alg !== undefined && value.alg !== "ES256") ||
      (value.use !== undefined && value.use !== "sig")
    ) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      value as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const kid = await platformKeyId(key);
    return value.kid === kid ? { kid, key } : null;
  } catch {
    return null;
  }
}

async function fetchJwks(jwksUrl: string): Promise<Map<string, CryptoKey>> {
  const parsed = new URL(jwksUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) {
    invalid();
  }
  const response = await fetch(jwksUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) invalid();
  const text = await response.text();
  if (textEncoder.encode(text).length > MAX_JWKS_BYTES) invalid();
  const document: unknown = JSON.parse(text);
  if (!isRecord(document) || !Array.isArray(document.keys) || document.keys.length > MAX_JWKS_KEYS) {
    invalid();
  }
  const keys = new Map<string, CryptoKey>();
  for (const candidate of document.keys) {
    const imported = await importPublicJwk(candidate);
    if (!imported) continue;
    if (keys.has(imported.kid)) invalid();
    keys.set(imported.kid, imported.key);
  }
  return keys;
}

async function refreshJwks(cache: JwksCacheEntry, jwksUrl: string): Promise<void> {
  if (cache.refreshing) return cache.refreshing;
  cache.refreshCooldownUntil = Date.now() + UNKNOWN_KID_REFRESH_COOLDOWN_MS;
  cache.refreshing = (async () => {
    const keys = await fetchJwks(jwksUrl);
    cache.keys = keys;
    cache.expiresAt = Date.now() + JWKS_TTL_MS;
  })().finally(() => {
    cache.refreshing = null;
  });
  return cache.refreshing;
}

function getCache(config: AuthConfig): JwksCacheEntry {
  const cacheKey = `${config.PLATFORM_ISSUER}\n${config.PLATFORM_JWKS_URL}`;
  let cache = jwksCaches.get(cacheKey);
  if (!cache) {
    cache = { keys: new Map(), expiresAt: 0, refreshCooldownUntil: 0, refreshing: null };
    jwksCaches.set(cacheKey, cache);
    if (jwksCaches.size > 8) {
      const oldest = jwksCaches.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== cacheKey) jwksCaches.delete(oldest);
    }
  }
  return cache;
}

async function verificationKey(kid: string, config: AuthConfig): Promise<CryptoKey> {
  const cache = getCache(config);
  const now = Date.now();
  let key = cache.keys.get(kid);
  if (key && now < cache.expiresAt) return key;
  if (cache.refreshing) {
    await cache.refreshing;
  } else if (now >= cache.refreshCooldownUntil) {
    await refreshJwks(cache, config.PLATFORM_JWKS_URL);
  }
  key = cache.keys.get(kid);
  if (!key) invalid();
  return key;
}

/** A WebCrypto implementation of the SDK's reusable network.request verification. */
export async function verifyPlatformRequest(options: VerifyOptions): Promise<PlatformIdentity> {
  try {
    const {
      authorization,
      PLATFORM_ISSUER: issuer,
      PLATFORM_AUDIENCE: audience,
      PLATFORM_APP_ID: appId,
      CHANNEL: channel,
      APP_VERSION: version,
      method,
      url,
    } = options;
    if (
      typeof authorization !== "string" ||
      authorization.length > 8199 ||
      !authorization.startsWith("Bearer ") ||
      typeof issuer !== "string" ||
      typeof audience !== "string" ||
      typeof appId !== "string" ||
      !["production", "sandbox"].includes(channel) ||
      typeof method !== "string" ||
      !/^[A-Z]+$/.test(method)
    ) {
      invalid();
    }

    const parts = authorization.slice(7).split(".");
    if (parts.length !== 3) invalid();
    const encodedHeader = parts[0]!;
    const encodedPayload = parts[1]!;
    const encodedSignature = parts[2]!;
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (
      !isRecord(header) ||
      header.alg !== "ES256" ||
      header.typ !== "mini-app-access+jwt" ||
      header.jku !== undefined ||
      header.jwk !== undefined ||
      header.x5u !== undefined ||
      header.crit !== undefined ||
      typeof header.kid !== "string"
    ) {
      invalid();
    }

    const publicKey = await verificationKey(header.kid, options);
    if ((await platformKeyId(publicKey)) !== header.kid) invalid();
    const signature = decodeBase64Url(encodedSignature);
    if (signature.length !== 64) invalid();
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature as BufferSource,
      textEncoder.encode(`${encodedHeader}.${encodedPayload}`) as BufferSource,
    );
    if (!valid) invalid();

    const now = Math.floor(options.now ?? Date.now() / 1000);
    if (!isRecord(payload)) invalid();
    const times = [payload.iat, payload.nbf, payload.exp, now];
    if (
      payload.iss !== issuer ||
      payload.aud !== audience ||
      payload.app_id !== appId ||
      payload.channel !== channel ||
      (version !== undefined && payload.version !== version) ||
      typeof payload.sub !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(payload.sub) ||
      typeof payload.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(payload.version) ||
      !Array.isArray(payload.scopes) ||
      payload.scopes.length !== 1 ||
      payload.scopes[0] !== "network.request" ||
      !times.every((value) => Number.isSafeInteger(value)) ||
      typeof payload.iat !== "number" ||
      typeof payload.nbf !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 900 ||
      payload.iat > now + 5 ||
      payload.nbf > now + 5 ||
      payload.nbf > payload.iat ||
      payload.iat - payload.nbf > 5 ||
      payload.exp <= now ||
      typeof payload.jti !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti) ||
      payload.htm !== method ||
      typeof payload.htu !== "string"
    ) {
      invalid();
    }

    const queryKeys = verifyEndpointUrl(payload.htu, payload.query_keys, url, audience);
    return Object.freeze({
      ...payload,
      scopes: Object.freeze(["network.request"]),
      query_keys: Object.freeze(queryKeys),
    }) as PlatformIdentity;
  } catch {
    throw new PlatformAuthError();
  }
}

export function externallyVisibleRequestUrl(request: Request, audience: string): string {
  const incoming = new URL(request.url);
  return `${audience}${incoming.pathname}${incoming.search}`;
}

export function authenticateRequest(
  request: Request,
  env: Pick<Env, keyof AuthConfig>,
  now?: number,
): Promise<PlatformIdentity> {
  const options: VerifyOptions = {
    authorization: request.headers.get("authorization"),
    method: request.method,
    url: externallyVisibleRequestUrl(request, env.PLATFORM_AUDIENCE),
    PLATFORM_ISSUER: env.PLATFORM_ISSUER,
    PLATFORM_JWKS_URL: env.PLATFORM_JWKS_URL,
    PLATFORM_AUDIENCE: env.PLATFORM_AUDIENCE,
    PLATFORM_APP_ID: env.PLATFORM_APP_ID,
    CHANNEL: env.CHANNEL,
    ...(env.APP_VERSION !== undefined ? { APP_VERSION: env.APP_VERSION } : {}),
    ...(now !== undefined ? { now } : {}),
  };
  return verifyPlatformRequest(options);
}

/** Only used to isolate tests that share one JS module instance. */
export function clearPlatformKeyCaches(): void {
  jwksCaches.clear();
}
