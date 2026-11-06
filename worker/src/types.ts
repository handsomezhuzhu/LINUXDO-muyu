export type Channel = "production" | "sandbox";

export interface PlatformIdentity {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly app_id: string;
  readonly version: string;
  readonly channel: Channel;
  readonly scopes: readonly ["network.request"];
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  readonly htm: string;
  readonly htu: string;
  readonly query_keys: readonly string[];
}

export type D1Value = string | number | null;

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;
  CHANNEL: Channel;
  PLATFORM_ISSUER: string;
  PLATFORM_JWKS_URL: string;
  PLATFORM_JWKS_JSON?: string;
  PLATFORM_AUDIENCE: string;
  PLATFORM_APP_ID: string;
  APP_VERSION?: string;
  CORS_ORIGIN: string;
}

export interface UserScope {
  iss: string;
  sub: string;
}

export interface Wish {
  id: string;
  content: string;
  target: number;
  progress: number;
  createdAt: string;
  completedAt?: string;
}

export interface MeritState {
  revision: number;
  total: number;
  today: number;
  activeWish: Wish | null;
  wishes: Wish[];
}
